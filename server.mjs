import { createServer } from 'node:http';
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = PACKAGE.version;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '5173', 10);
const DATA_FILE = resolve(process.env.DATA_FILE || join(ROOT, 'data', 'db.json'));
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BASE_PATH = '/agent-hub-web';

const SESSION_COOKIE = 'agent_hub_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_BODY_BYTES = 64 * 1024;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 256;
const PBKDF2_ITERATIONS = 220_000;
const LEGACY_PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = 'sha512';
const pbkdf2Async = promisify(pbkdf2);
const dummySalt = randomBytes(16).toString('hex');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const PUBLIC_FILES = new Set(['/index.html', '/404.html', '/app.js', '/styles.css', '/.nojekyll']);
const rateBuckets = new Map();
let state;
let writeQueue = Promise.resolve();

function createEmptyState() {
  return {
    users: [],
    sessions: [],
    agents: [],
    conversations: [],
    messages: [],
    nextIds: { user: 1, agent: 1, conversation: 1, message: 1 },
  };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('El archivo de datos no contiene un objeto JSON valido.');
  }

  const normalized = createEmptyState();
  for (const key of ['users', 'sessions', 'agents', 'conversations', 'messages']) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new Error(`La coleccion ${key} del archivo de datos no es valida.`);
    }
    normalized[key] = value[key] || [];
  }

  const maxima = {
    user: maxNumericId(normalized.users),
    agent: maxNumericId(normalized.agents),
    conversation: maxNumericId(normalized.conversations),
    message: maxNumericId(normalized.messages),
  };

  for (const key of Object.keys(normalized.nextIds)) {
    const candidate = Number(value.nextIds?.[key]);
    normalized.nextIds[key] = Math.max(Number.isSafeInteger(candidate) ? candidate : 1, maxima[key] + 1, 1);
  }

  return normalized;
}

function maxNumericId(records) {
  return records.reduce((highest, record) => {
    const id = Number(record?.id);
    return Number.isSafeInteger(id) ? Math.max(highest, id) : highest;
  }, 0);
}

async function ensureStateLoaded() {
  if (state) return state;

  try {
    state = normalizeState(JSON.parse(await readFile(DATA_FILE, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    state = createEmptyState();
    await persistState(state);
  }

  return state;
}

async function persistState(nextState) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await writeFile(temporaryFile, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryFile, DATA_FILE);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function mutateState(mutator) {
  let result;
  const operation = writeQueue.then(async () => {
    const current = await ensureStateLoaded();
    const draft = structuredClone(current);
    result = await mutator(draft);
    await persistState(draft);
    state = draft;
  });

  writeQueue = operation.catch(() => {});
  await operation;
  return result;
}

function securityHeaders(contentType, cacheControl = 'no-store') {
  const headers = {
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  };

  if (IS_PRODUCTION) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

function apiHeaders() {
  return {
    ...securityHeaders('application/json; charset=utf-8'),
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
}

function staticHeaders(filePath) {
  const extension = extname(filePath).toLowerCase();
  const immutable = ['.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2'].includes(extension);
  const headers = securityHeaders(MIME_TYPES.get(extension) || 'application/octet-stream', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  headers['Content-Security-Policy'] = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self'",
  ].join('; ');
  return headers;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { ...apiHeaders(), ...extraHeaders, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendEmpty(res, statusCode, headers = {}) {
  res.writeHead(statusCode, { ...securityHeaders('text/plain; charset=utf-8'), ...headers, 'Content-Length': '0' });
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('El cuerpo de la solicitud es demasiado grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body');
    return value;
  } catch {
    const error = new Error('El cuerpo JSON no es valido.');
    error.statusCode = 400;
    throw error;
  }
}

function hasRequestBody(req) {
  return Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
}

function requestOrigin(req) {
  const protocol = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : 'http';
  return `${protocol}://${req.headers.host}`;
}

function isMutationAllowed(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).origin === new URL(requestOrigin(req)).origin;
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const cookies = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    try {
      cookies[decodeURIComponent(pair.slice(0, separator).trim())] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the request.
    }
  }
  return cookies;
}

function sessionCookie(value, maxAge = SESSION_TTL_SECONDS) {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, scope, limit, windowMs) {
  const key = `${scope}:${clientIp(req)}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.expiresAt <= now) {
    rateBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.expiresAt <= now) rateBuckets.delete(key);
  }
}, 60_000).unref();

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function text(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeUrl(value) {
  const candidate = text(value, 2_048);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS, digest = PBKDF2_DIGEST) {
  const derived = await pbkdf2Async(password, salt, iterations, PBKDF2_KEY_LENGTH, digest);
  return Buffer.from(derived).toString('hex');
}

function hashesMatch(leftHex, rightHex) {
  try {
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name || String(user.email || '').split('@')[0],
    email: user.email,
    createdAt: user.createdAt,
  };
}

function owns(record, userId) {
  return Number(record?.userId ?? record?.ownerId) === Number(userId);
}

async function authenticatedUser(req) {
  const current = await ensureStateLoaded();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const session = current.sessions.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now());
  if (!session) return null;
  return current.users.find((item) => Number(item.id) === Number(session.userId)) || null;
}

function nextId(draft, key) {
  const id = draft.nextIds[key];
  draft.nextIds[key] += 1;
  return id;
}

function routeId(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function requireUser(req, res) {
  const user = await authenticatedUser(req);
  if (!user) sendJson(res, 401, { error: 'Inicia sesion para continuar.' });
  return user;
}

async function handleApi(req, res, pathname) {
  if (!checkRateLimit(req, 'api', 240, 60_000)) {
    sendJson(res, 429, { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' }, { 'Retry-After': '60' });
    return;
  }

  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (isMutation && !isMutationAllowed(req)) {
    sendJson(res, 403, { error: 'Origen de solicitud no permitido.' });
    return;
  }

  if (isMutation && hasRequestBody(req) && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { error: 'Usa Content-Type: application/json.' });
    return;
  }

  if (pathname === '/api/version' && req.method === 'GET') {
    sendJson(res, 200, { version: APP_VERSION });
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, version: APP_VERSION });
    return;
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    if (!checkRateLimit(req, 'auth', 12, 15 * 60_000)) {
      sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' }, { 'Retry-After': '900' });
      return;
    }

    const body = await readJsonBody(req);
    const name = text(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!email) return sendJson(res, 400, { error: 'Escribe un correo valido.' });
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      return sendJson(res, 400, { error: `La contrasena debe tener entre ${PASSWORD_MIN_LENGTH} y ${PASSWORD_MAX_LENGTH} caracteres.` });
    }

    const current = await ensureStateLoaded();
    if (current.users.some((user) => user.email === email)) return sendJson(res, 409, { error: 'Ese correo ya esta registrado.' });

    const salt = randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();

    const user = await mutateState((draft) => {
      if (draft.users.some((item) => item.email === email)) {
        const error = new Error('Ese correo ya esta registrado.');
        error.statusCode = 409;
        throw error;
      }
      const created = {
        id: nextId(draft, 'user'),
        name: name || email.split('@')[0],
        email,
        passwordHash,
        passwordSalt: salt,
        passwordIterations: PBKDF2_ITERATIONS,
        passwordDigest: PBKDF2_DIGEST,
        createdAt: now,
      };
      draft.users.push(created);
      draft.sessions.push({ tokenHash, userId: created.id, createdAt: now, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString() });
      return created;
    });

    sendJson(res, 201, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (!checkRateLimit(req, 'auth', 12, 15 * 60_000)) {
      sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' }, { 'Retry-After': '900' });
      return;
    }

    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!email || !password || password.length > PASSWORD_MAX_LENGTH) return sendJson(res, 401, { error: 'Correo o contrasena incorrectos.' });

    const current = await ensureStateLoaded();
    const user = current.users.find((item) => item.email === email);
    const salt = user?.passwordSalt || dummySalt;
    const iterations = Number(user?.passwordIterations) || LEGACY_PBKDF2_ITERATIONS;
    const digest = user?.passwordDigest || PBKDF2_DIGEST;
    const candidateHash = await hashPassword(password, salt, iterations, digest);

    if (!user || !hashesMatch(candidateHash, user.passwordHash)) return sendJson(res, 401, { error: 'Correo o contrasena incorrectos.' });

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    await mutateState(async (draft) => {
      const storedUser = draft.users.find((item) => Number(item.id) === Number(user.id));
      if (iterations !== PBKDF2_ITERATIONS || digest !== PBKDF2_DIGEST) {
        storedUser.passwordHash = await hashPassword(password, storedUser.passwordSalt);
        storedUser.passwordIterations = PBKDF2_ITERATIONS;
        storedUser.passwordDigest = PBKDF2_DIGEST;
      }
      draft.sessions = draft.sessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
      draft.sessions.push({ tokenHash, userId: user.id, createdAt: now, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString() });
    });

    sendJson(res, 200, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await mutateState((draft) => {
        draft.sessions = draft.sessions.filter((session) => session.tokenHash !== tokenHash);
      });
    }
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (user) sendJson(res, 200, { user: safeUser(user) });
    return;
  }

  if (pathname === '/api/agents' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const current = await ensureStateLoaded();
    sendJson(res, 200, { agents: current.agents.filter((agent) => owns(agent, user.id)) });
    return;
  }

  if (pathname === '/api/agents' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const name = text(body.name, 80);
    const model = text(body.model, 60) || 'gpt-4o-mini';
    const instructions = text(body.instructions, 2_000);
    const description = text(body.description, 600);
    const url = normalizeUrl(body.url);
    if (!name) return sendJson(res, 400, { error: 'El agente necesita un nombre.' });
    if (url === null) return sendJson(res, 400, { error: 'La URL debe usar http o https.' });

    const now = new Date().toISOString();
    const agent = await mutateState((draft) => {
      const created = {
        id: nextId(draft, 'agent'),
        userId: user.id,
        name,
        model,
        instructions,
        description,
        category: text(body.category, 80),
        status: text(body.status, 32) || 'active',
        url,
        createdAt: now,
        updatedAt: now,
      };
      draft.agents.push(created);
      return created;
    });
    sendJson(res, 201, { agent });
    return;
  }

  const agentId = routeId(pathname, /^\/api\/agents\/(\d+)$/);
  if (agentId && req.method === 'PUT') {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const name = body.name === undefined ? undefined : text(body.name, 80);
    const model = body.model === undefined ? undefined : text(body.model, 60);
    const url = body.url === undefined ? undefined : normalizeUrl(body.url);
    if (name === '') return sendJson(res, 400, { error: 'El agente necesita un nombre.' });
    if (model === '') return sendJson(res, 400, { error: 'El agente necesita un modelo.' });
    if (url === null) return sendJson(res, 400, { error: 'La URL debe usar http o https.' });

    const agent = await mutateState((draft) => {
      const stored = draft.agents.find((item) => Number(item.id) === agentId && owns(item, user.id));
      if (!stored) return null;
      if (name !== undefined) stored.name = name;
      if (model !== undefined) stored.model = model;
      if (body.instructions !== undefined) stored.instructions = text(body.instructions, 2_000);
      if (body.description !== undefined) stored.description = text(body.description, 600);
      if (body.category !== undefined) stored.category = text(body.category, 80);
      if (body.status !== undefined) stored.status = text(body.status, 32) || 'active';
      if (url !== undefined) stored.url = url;
      stored.updatedAt = new Date().toISOString();
      return stored;
    });
    if (!agent) return sendJson(res, 404, { error: 'Agente no encontrado.' });
    sendJson(res, 200, { agent });
    return;
  }

  if (agentId && req.method === 'DELETE') {
    const user = await requireUser(req, res);
    if (!user) return;
    const removed = await mutateState((draft) => {
      const index = draft.agents.findIndex((item) => Number(item.id) === agentId && owns(item, user.id));
      if (index < 0) return false;
      draft.agents.splice(index, 1);
      const conversationIds = new Set(draft.conversations.filter((item) => Number(item.agentId) === agentId && owns(item, user.id)).map((item) => Number(item.id)));
      draft.conversations = draft.conversations.filter((item) => !conversationIds.has(Number(item.id)));
      draft.messages = draft.messages.filter((item) => !conversationIds.has(Number(item.conversationId)));
      return true;
    });
    if (!removed) return sendJson(res, 404, { error: 'Agente no encontrado.' });
    sendJson(res, 200, { ok: true });
    return;
  }

  const conversationAgentId = routeId(pathname, /^\/api\/agents\/(\d+)\/conversations$/);
  if (conversationAgentId && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const current = await ensureStateLoaded();
    const agent = current.agents.find((item) => Number(item.id) === conversationAgentId && owns(item, user.id));
    if (!agent) return sendJson(res, 404, { error: 'Agente no encontrado.' });
    sendJson(res, 200, { conversations: current.conversations.filter((item) => Number(item.agentId) === conversationAgentId && owns(item, user.id)) });
    return;
  }

  if (conversationAgentId && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const current = await ensureStateLoaded();
    const agent = current.agents.find((item) => Number(item.id) === conversationAgentId && owns(item, user.id));
    if (!agent) return sendJson(res, 404, { error: 'Agente no encontrado.' });
    const now = new Date().toISOString();
    const conversation = await mutateState((draft) => {
      const created = {
        id: nextId(draft, 'conversation'),
        userId: user.id,
        agentId: conversationAgentId,
        title: text(body.title, 120) || `Sesion con ${agent.name}`,
        createdAt: now,
        updatedAt: now,
      };
      draft.conversations.push(created);
      return created;
    });
    sendJson(res, 201, { conversation });
    return;
  }

  const conversationId = routeId(pathname, /^\/api\/conversations\/(\d+)$/);
  if (conversationId && req.method === 'DELETE') {
    const user = await requireUser(req, res);
    if (!user) return;
    const removed = await mutateState((draft) => {
      const index = draft.conversations.findIndex((item) => Number(item.id) === conversationId && owns(item, user.id));
      if (index < 0) return false;
      draft.conversations.splice(index, 1);
      draft.messages = draft.messages.filter((item) => Number(item.conversationId) !== conversationId);
      return true;
    });
    if (!removed) return sendJson(res, 404, { error: 'Conversacion no encontrada.' });
    sendJson(res, 200, { ok: true });
    return;
  }

  const messagesConversationId = routeId(pathname, /^\/api\/conversations\/(\d+)\/messages$/);
  if (messagesConversationId && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const current = await ensureStateLoaded();
    const conversation = current.conversations.find((item) => Number(item.id) === messagesConversationId && owns(item, user.id));
    if (!conversation) return sendJson(res, 404, { error: 'Conversacion no encontrada.' });
    sendJson(res, 200, { messages: current.messages.filter((item) => Number(item.conversationId) === messagesConversationId) });
    return;
  }

  if (messagesConversationId && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const role = String(body.role || '').trim().toLowerCase();
    const content = text(body.content, 8_000);
    if (!['user', 'assistant', 'system'].includes(role)) return sendJson(res, 400, { error: 'El rol del mensaje no es valido.' });
    if (!content) return sendJson(res, 400, { error: 'El mensaje no puede estar vacio.' });

    const current = await ensureStateLoaded();
    const conversation = current.conversations.find((item) => Number(item.id) === messagesConversationId && owns(item, user.id));
    if (!conversation) return sendJson(res, 404, { error: 'Conversacion no encontrada.' });
    const now = new Date().toISOString();
    const message = await mutateState((draft) => {
      const created = { id: nextId(draft, 'message'), userId: user.id, conversationId: messagesConversationId, role, content, createdAt: now };
      draft.messages.push(created);
      const storedConversation = draft.conversations.find((item) => Number(item.id) === messagesConversationId);
      if (storedConversation) storedConversation.updatedAt = now;
      return created;
    });
    sendJson(res, 201, { message });
    return;
  }

  sendJson(res, 404, { error: 'Ruta de API no encontrada.' });
}

function normalizedPublicPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === BASE_PATH) return '/';
  if (decoded.startsWith(`${BASE_PATH}/`)) return decoded.slice(BASE_PATH.length);
  return decoded;
}

async function serveFile(req, res, filePath, statusCode = 200) {
  const resolved = resolve(filePath);
  const relativePath = relative(ROOT, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    sendJson(res, 403, { error: 'Acceso denegado.' });
    return;
  }

  const body = await readFile(resolved);
  const headers = { ...staticHeaders(resolved), 'Content-Length': body.length };
  res.writeHead(statusCode, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

async function handleStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    sendEmpty(res, 405, { Allow: 'GET, HEAD' });
    return;
  }

  const publicPath = normalizedPublicPath(pathname);
  if (!publicPath) {
    sendJson(res, 400, { error: 'Ruta no valida.' });
    return;
  }

  if (publicPath === '/data/db.json' || publicPath.startsWith('/data/')) {
    sendJson(res, 403, { error: 'Acceso denegado.' });
    return;
  }

  const requestedFile = publicPath === '/' ? '/index.html' : publicPath;
  const isAsset = ['/assets/', '/brand/'].some((prefix) => requestedFile.startsWith(prefix)) && !requestedFile.includes('/.');
  if (!PUBLIC_FILES.has(requestedFile) && !isAsset) {
    if (extname(requestedFile)) {
      await serveFile(req, res, join(ROOT, '404.html'), 404);
      return;
    }
    await serveFile(req, res, join(ROOT, 'index.html'));
    return;
  }

  const filePath = join(ROOT, requestedFile.slice(1));
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    await serveFile(req, res, filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await serveFile(req, res, join(ROOT, '404.html'), 404);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname);
    else await handleStatic(req, res, url.pathname);
  })().catch((error) => {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) console.error(error);
    if (!res.headersSent) sendJson(res, statusCode, { error: statusCode >= 500 ? 'Error interno del servidor.' : error.message });
    else res.end();
  });
});

await ensureStateLoaded();
server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`Agent Hub v${APP_VERSION} disponible en http://${HOST}:${actualPort}`);
});
