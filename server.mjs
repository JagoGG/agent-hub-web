import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(ROOT_DIR, 'data', 'db.json');
const COOKIE_NAME = 'ah_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 120 * 1024;
const IS_PROD = process.env.NODE_ENV === 'production';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
]);

const rateLimits = {
  register: { windowMs: 15 * 60 * 1000, max: 8 },
  login: { windowMs: 15 * 60 * 1000, max: 20 },
  messages: { windowMs: 60 * 1000, max: 100 },
};
const rateBuckets = new Map();

const initialState = {
  users: [],
  sessions: [],
  agents: [],
  conversations: [],
  messages: [],
  meta: {
    nextUserId: 1,
    nextSessionId: 1,
    nextAgentId: 1,
    nextConversationId: 1,
    nextMessageId: 1,
  },
};

let state = clone(initialState);
let stateLock = Promise.resolve();

await ensureStateLoaded();
const server = createServer(requestHandler);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Agent Hub API listening at http://localhost:${PORT}`);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function headersBase() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; frame-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self';",
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeRole(value) {
  const role = String(value || '').toLowerCase().trim();
  return role === 'assistant' || role === 'system' || role === 'user' ? role : 'user';
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, 120_000, 64, 'sha512').toString('hex');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function secureEqualsHex(a, b) {
  try {
    const aBuf = Buffer.from(a, 'hex');
    const bBuf = Buffer.from(b, 'hex');
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function safeParseCookies(cookieHeader = '') {
  const entries = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split('='));
  return entries.reduce((acc, [name, ...valueParts]) => {
    acc[decodeURIComponent(name)] = decodeURIComponent(valueParts.join('='));
    return acc;
  }, {});
}

function setAuthCookie(headers, token, expiresAt) {
  const cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (IS_PROD) cookie.push('Secure');
  headers['Set-Cookie'] = cookie.join('; ');
}

function clearAuthCookie(headers) {
  const cookie = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (IS_PROD) cookie.push('Secure');
  headers['Set-Cookie'] = cookie.join('; ');
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...headersBase(),
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response, statusCode, message, extra) {
  sendJson(response, statusCode, { error: message, ...extra });
}

function isRateLimited(type, identity) {
  const cfg = rateLimits[type];
  if (!cfg) return false;

  const now = Date.now();
  const bucket = rateBuckets.get(identity);
  if (!bucket || bucket.type !== type || now - bucket.windowStart > cfg.windowMs) {
    rateBuckets.set(identity, { type, windowStart: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  if (bucket.count > cfg.max) {
    return true;
  }

  return false;
}

function withState(mutator, persist = false) {
  const task = stateLock.then(async () => {
    const result = await mutator(state);
    if (persist) await persistState();
    return result;
  });

  stateLock = task.catch(() => {});
  return task;
}

function purgeExpiredSessions(tx, now = Date.now()) {
  tx.sessions = tx.sessions.filter((session) => session.expiresAt > now);
}

async function ensureStateLoaded() {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await access(DATA_FILE, constants.F_OK);
    const raw = await readFile(DATA_FILE, 'utf8');
    state = JSON.parse(raw);
    state = sanitizeState(state);
  } catch {
    state = clone(initialState);
    await persistState();
  }
}

function sanitizeState(loaded) {
  const merged = clone(initialState);
  if (!loaded || typeof loaded !== 'object') return merged;

  merged.users = Array.isArray(loaded.users) ? loaded.users : [];
  merged.sessions = Array.isArray(loaded.sessions) ? loaded.sessions : [];
  merged.agents = Array.isArray(loaded.agents) ? loaded.agents : [];
  merged.conversations = Array.isArray(loaded.conversations) ? loaded.conversations : [];
  merged.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  merged.meta = {
    nextUserId: Number(loaded?.meta?.nextUserId) || 1,
    nextSessionId: Number(loaded?.meta?.nextSessionId) || 1,
    nextAgentId: Number(loaded?.meta?.nextAgentId) || 1,
    nextConversationId: Number(loaded?.meta?.nextConversationId) || 1,
    nextMessageId: Number(loaded?.meta?.nextMessageId) || 1,
  };

  return merged;
}

async function persistState() {
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PAYLOAD_BYTES) {
        reject(new Error('PayloadTooLarge'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('InvalidJson'));
      }
    });
  });
}

function getClientIdentity(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const direct = req.socket.remoteAddress;
  return (
    (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]) ||
    direct ||
    'unknown'
  );
}

async function getAuthenticatedUser(req) {
  const cookies = safeParseCookies(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const now = Date.now();

  return withState((tx) => {
    purgeExpiredSessions(tx, now);
    const session = tx.sessions.find(
      (item) => item.tokenHash === tokenHash && item.expiresAt > now,
    );
    if (!session) return null;

    const user = tx.users.find((item) => item.id === session.userId);
    if (!user) return null;

    return { user: sanitizeUser(user), session };
  });
}

async function createSession(tx, userId, userAgent = '') {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = Date.now();
  const session = {
    id: tx.meta.nextSessionId++,
    userId,
    tokenHash,
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
    userAgent: sanitizeText(userAgent, 300),
  };
  tx.sessions.push(session);
  return { token, expiresAt: session.expiresAt };
}

function buildAgentPayload(agent) {
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    instructions: agent.instructions,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function buildConversationPayload(conversation, counts = 0) {
  return {
    id: conversation.id,
    agentId: conversation.agentId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    isArchived: !!conversation.isArchived,
    messageCount: counts,
  };
}

function buildMessagePayload(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  };
}

async function requestHandler(req, res) {
  const method = req.method?.toUpperCase();
  if (!method) {
    sendError(res, 400, 'Bad request');
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathName = url.pathname || '/';
  if (pathName.startsWith('/api/')) {
    await handleApi(req, res, method, pathName, url);
    return;
  }

  await serveStaticOrFallback(req, res, pathName);
}

async function handleApi(req, res, method, pathName, url) {
  const parts = pathName.split('?')[0].split('/').filter(Boolean);
  const segments = parts.slice(1); // remove api
  const bodyAllowed = method === 'POST' || method === 'PATCH' || method === 'PUT';
  let body = {};

  if (bodyAllowed) {
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      if (error.message === 'PayloadTooLarge') return sendError(res, 413, 'Payload too large');
      if (error.message === 'InvalidJson') return sendError(res, 400, 'Invalid JSON body');
      return sendError(res, 400, 'Could not parse body');
    }
  }

  if (segments.length === 1 && segments[0] === 'health' && method === 'GET') {
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (segments.length === 1 && segments[0] === 'register' && method === 'POST') {
    const ip = getClientIdentity(req);
    const key = `register|${ip}`;
    if (isRateLimited('register', key)) {
      sendError(res, 429, 'Too many registration attempts');
      return;
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const name = sanitizeText(body.name, 80) || email.split('@')[0] || 'Usuario';

    if (!validateEmail(email)) {
      sendError(res, 400, 'Email inválido');
      return;
    }
    if (!password || password.length < 10) {
      sendError(res, 400, 'La contraseña debe tener al menos 10 caracteres');
      return;
    }

    const result = await withState(async (tx) => {
      purgeExpiredSessions(tx);
      if (tx.users.some((user) => user.email === email)) {
        return { error: 'EMAIL_EXISTS' };
      }

      const now = new Date().toISOString();
      const salt = randomBytes(16).toString('hex');
      const user = {
        id: tx.meta.nextUserId++,
        email,
        name,
        salt,
        passwordHash: hashPassword(password, salt),
        createdAt: now,
        updatedAt: now,
      };
      tx.users.push(user);
      const { token, expiresAt } = await createSession(tx, user.id, req.headers['user-agent']);
      return { user, token, expiresAt };
    }, true);

    if (result.error === 'EMAIL_EXISTS') {
      sendError(res, 409, 'Ese correo ya está registrado');
      return;
    }

    const headers = {};
    setAuthCookie(headers, result.token, result.expiresAt);
    sendJson(
      res,
      201,
      {
        user: sanitizeUser(result.user),
        session: { expiresAt: new Date(result.expiresAt).toISOString() },
      },
      headers,
    );
    return;
  }

  if (segments.length === 1 && segments[0] === 'login' && method === 'POST') {
    const ip = getClientIdentity(req);
    const key = `login|${ip}`;
    if (isRateLimited('login', key)) {
      sendError(res, 429, 'Too many login attempts');
      return;
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const invalidCredentialError = () => sendError(res, 401, 'Correo o contraseña inválidos');

    const result = await withState(async (tx) => {
      purgeExpiredSessions(tx);
      const user = tx.users.find((item) => item.email === email);
      if (!user) return { error: 'BAD_CREDENTIALS' };

      const expected = user.passwordHash;
      const actual = hashPassword(password, user.salt);
      if (!secureEqualsHex(actual, expected)) return { error: 'BAD_CREDENTIALS' };

      const { token, expiresAt } = await createSession(tx, user.id, req.headers['user-agent']);
      user.updatedAt = new Date().toISOString();
      return { user, token, expiresAt };
    }, true);

    if (result.error === 'BAD_CREDENTIALS') {
      invalidCredentialError();
      return;
    }

    if (!result.user || !result.token) {
      sendError(res, 500, 'No fue posible iniciar sesión');
      return;
    }

    const headers = {};
    setAuthCookie(headers, result.token, result.expiresAt);
    sendJson(
      res,
      200,
      {
        user: sanitizeUser(result.user),
        session: { expiresAt: new Date(result.expiresAt).toISOString() },
      },
      headers,
    );
    return;
  }

  if (segments.length === 1 && segments[0] === 'logout' && method === 'POST') {
    const auth = await getAuthenticatedUser(req);
    const headers = {};
    if (auth?.session?.tokenHash) {
      await withState((tx) => {
        tx.sessions = tx.sessions.filter((item) => item.tokenHash !== auth.session.tokenHash);
      }, true);
    }
    clearAuthCookie(headers);
    sendJson(res, 200, { ok: true }, headers);
    return;
  }

  if (segments.length === 1 && segments[0] === 'me' && method === 'GET') {
    const auth = await getAuthenticatedUser(req);
    if (!auth) {
      sendError(res, 401, 'No autenticado');
      return;
    }

    sendJson(res, 200, {
      user: auth.user,
    });
    return;
  }

  if (segments[0] === 'agents') {
    const auth = await getAuthenticatedUser(req);
    if (!auth) {
      sendError(res, 401, 'No autenticado');
      return;
    }

    if (segments.length === 1 && method === 'GET') {
      const payload = await withState((tx) =>
        tx.agents.filter((agent) => agent.userId === auth.user.id).map(buildAgentPayload),
      );
      sendJson(res, 200, payload);
      return;
    }

    if (segments.length === 1 && method === 'POST') {
      const name = sanitizeText(body.name, 80) || 'Agente sin nombre';
      const model = sanitizeText(body.model, 60) || 'gpt-4o-mini';
      const instructions = sanitizeText(body.instructions, 2000);

      const agent = await withState((tx) => {
        const record = {
          id: tx.meta.nextAgentId++,
          userId: auth.user.id,
          name,
          model,
          instructions,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tx.agents.push(record);
        return record;
      }, true);
      sendJson(res, 201, buildAgentPayload(agent));
      return;
    }

    const agentId = Number(segments[1]);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      sendError(res, 400, 'ID de agente inválido');
      return;
    }

    if (segments.length >= 2) {
      if (segments.length === 2 && method === 'PATCH') {
        const updates = body || {};
        const updated = await withState((tx) => {
          const agent = tx.agents.find(
            (item) => item.id === agentId && item.userId === auth.user.id,
          );
          if (!agent) return null;

          if (updates.name !== undefined) agent.name = sanitizeText(updates.name, 80) || agent.name;
          if (updates.model !== undefined) agent.model = sanitizeText(updates.model, 60) || agent.model;
          if (updates.instructions !== undefined) {
            agent.instructions = sanitizeText(updates.instructions, 2000);
          }
          agent.updatedAt = new Date().toISOString();
          return agent;
        }, true);
        if (!updated) {
          sendError(res, 404, 'Agente no encontrado');
          return;
        }
        sendJson(res, 200, buildAgentPayload(updated));
        return;
      }

      if (segments.length === 2 && method === 'DELETE') {
        await withState((tx) => {
          const beforeAgents = tx.agents.length;
          tx.agents = tx.agents.filter(
            (item) => !(item.id === agentId && item.userId === auth.user.id),
          );
          if (tx.agents.length === beforeAgents) return null;

          const affectedConversations = tx.conversations
            .filter((conv) => conv.agentId === agentId && conv.userId === auth.user.id)
            .map((conv) => conv.id);
          tx.conversations = tx.conversations.filter((conv) => !affectedConversations.includes(conv.id));
          tx.messages = tx.messages.filter(
            (message) => !affectedConversations.includes(message.conversationId),
          );
          return { agentId };
        }, true);

        sendJson(res, 200, { ok: true });
        return;
      }

      if (segments.length === 3 && segments[2] === 'conversations' && method === 'GET') {
        const payload = await withState((tx) =>
          tx.conversations
            .filter((conv) => conv.agentId === agentId && conv.userId === auth.user.id)
            .map((conv) =>
              buildConversationPayload(
                conv,
                tx.messages.filter((msg) => msg.conversationId === conv.id).length,
              ),
            ),
        );
        sendJson(res, 200, payload);
        return;
      }
    }

    sendError(res, 404, 'Recurso de agentes no encontrado');
    return;
  }

  if (segments[0] === 'conversations') {
    const auth = await getAuthenticatedUser(req);
    if (!auth) {
      sendError(res, 401, 'No autenticado');
      return;
    }

    if (segments.length === 1 && method === 'GET') {
      const agentIdParam = url.searchParams.get('agentId');
      const agentId = Number(agentIdParam);
      const payload = await withState((tx) => {
        const list = tx.conversations.filter((conv) => conv.userId === auth.user.id);
        const filtered = Number.isInteger(agentId) && agentId > 0
          ? list.filter((conv) => conv.agentId === agentId)
          : list;
        return filtered.map((conv) =>
          buildConversationPayload(
            conv,
            tx.messages.filter((msg) => msg.conversationId === conv.id).length,
          ),
        );
      });
      sendJson(res, 200, payload);
      return;
    }

    if (segments.length === 1 && method === 'POST') {
      const title = sanitizeText(body.title, 120) || 'Conversación sin título';
      const agentId = Number(body.agentId);

      if (!Number.isInteger(agentId) || agentId <= 0) {
        sendError(res, 400, 'agentId inválido');
        return;
      }

      const conversation = await withState((tx) => {
        const ownsAgent = tx.agents.some(
          (agent) => agent.id === agentId && agent.userId === auth.user.id,
        );
        if (!ownsAgent) return { error: 'AGENT_NOT_FOUND' };

        const record = {
          id: tx.meta.nextConversationId++,
          userId: auth.user.id,
          agentId,
          title,
          isArchived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tx.conversations.push(record);
        return record;
      }, true);

      if (conversation.error === 'AGENT_NOT_FOUND') {
        sendError(res, 404, 'Agente no encontrado');
        return;
      }

      sendJson(res, 201, buildConversationPayload(conversation, 0));
      return;
    }

    const conversationId = Number(segments[1]);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      sendError(res, 400, 'ID de conversación inválido');
      return;
    }

    if (segments.length === 2 && method === 'GET') {
      const payload = await withState((tx) => {
        const conversation = tx.conversations.find(
          (item) => item.id === conversationId && item.userId === auth.user.id,
        );
        if (!conversation) return null;
        return buildConversationPayload(
          conversation,
          tx.messages.filter((msg) => msg.conversationId === conversationId).length,
        );
      });
      if (!payload) {
        sendError(res, 404, 'Conversación no encontrada');
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (segments.length === 2 && method === 'PATCH') {
      const payload = await withState((tx) => {
        const conversation = tx.conversations.find(
          (item) => item.id === conversationId && item.userId === auth.user.id,
        );
        if (!conversation) return null;
        if (body.title !== undefined) conversation.title = sanitizeText(body.title, 120) || conversation.title;
        if (body.isArchived !== undefined) conversation.isArchived = !!body.isArchived;
        conversation.updatedAt = new Date().toISOString();
        return conversation;
      }, true);
      if (!payload) {
        sendError(res, 404, 'Conversación no encontrada');
        return;
      }
      sendJson(res, 200, buildConversationPayload(payload));
      return;
    }

    if (segments.length === 2 && method === 'DELETE') {
      const deleted = await withState((tx) => {
        const conversation = tx.conversations.find(
          (item) => item.id === conversationId && item.userId === auth.user.id,
        );
        if (!conversation) return null;

        tx.conversations = tx.conversations.filter((item) => item.id !== conversationId);
        tx.messages = tx.messages.filter((msg) => msg.conversationId !== conversationId);
        return conversation;
      }, true);
      if (!deleted) {
        sendError(res, 404, 'Conversación no encontrada');
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (segments.length === 3 && segments[2] === 'messages' && method === 'GET') {
      const payload = await withState((tx) => {
        const conversation = tx.conversations.find(
          (item) => item.id === conversationId && item.userId === auth.user.id,
        );
        if (!conversation) return null;

        const messages = tx.messages
          .filter((item) => item.conversationId === conversationId)
          .sort((a, b) => a.id - b.id)
          .map(buildMessagePayload);
        return { conversation: buildConversationPayload(conversation), messages };
      });
      if (!payload) {
        sendError(res, 404, 'Conversación no encontrada');
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (segments.length === 3 && segments[2] === 'messages' && method === 'POST') {
      const rateKey = `messages|${getClientIdentity(req)}|${auth.user.id}`;
      if (isRateLimited('messages', rateKey)) {
        sendError(res, 429, 'Demasiados mensajes enviados recientemente');
        return;
      }

      const role = normalizeRole(body.role || 'user');
      const content = sanitizeText(body.content, 4000);
      if (!content) {
        sendError(res, 400, 'El mensaje no puede estar vacío');
        return;
      }

      const ip = getClientIdentity(req);
      const message = await withState((tx) => {
        const conversation = tx.conversations.find(
          (item) => item.id === conversationId && item.userId === auth.user.id,
        );
        if (!conversation) return { error: 'CONVERSATION_NOT_FOUND' };

        const record = {
          id: tx.meta.nextMessageId++,
          conversationId,
          role,
          content,
          createdAt: new Date().toISOString(),
          createdByIp: sanitizeText(ip, 80),
        };
        tx.messages.push(record);
        conversation.updatedAt = new Date().toISOString();
        return record;
      }, true);

      if (message.error === 'CONVERSATION_NOT_FOUND') {
        sendError(res, 404, 'Conversación no encontrada');
        return;
      }

      sendJson(res, 201, buildMessagePayload(message));
      return;
    }

    sendError(res, 404, 'Recurso no encontrado');
    return;
  }

  sendError(res, 404, 'API endpoint no encontrado');
}

async function serveStaticOrFallback(req, res, pathname) {
  const safePath = pathname.replace(/\.{2,}/g, '');
  const fileName = safePath === '/' ? 'index.html' : safePath.replace(/^\//, '');

  if (!safePath.startsWith('/')) {
    res.writeHead(400, headersBase());
    res.end('Invalid path');
    return;
  }

  const candidate = path.join(ROOT_DIR, fileName);
  if (!candidate.startsWith(ROOT_DIR)) {
    res.writeHead(400, headersBase());
    res.end('Invalid path');
    return;
  }

  const normalized = path.normalize(candidate);
  if (normalized.startsWith(path.join(ROOT_DIR, 'data'))) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const fileStat = await stat(normalized);
    if (fileStat.isFile()) {
      const ext = path.extname(normalized).toLowerCase();
      const body = await readFile(normalized);
      res.writeHead(200, {
        ...headersBase(),
        'Content-Type': MIME_TYPES.get(ext) || 'application/octet-stream',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
  } catch {
    // If static file not found, fall back to app shell.
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      const indexBody = await readFile(path.join(ROOT_DIR, 'index.html'));
      res.writeHead(200, {
        ...headersBase(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': indexBody.length,
      });
      res.end(indexBody);
      return;
    } catch {
      sendError(res, 500, 'index.html no encontrado');
      return;
    }
  }

  sendJson(res, 405, 'Método no permitido');
}
