import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function startServer(dataFile) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_FILE: dataFile, NODE_ENV: 'test', TRUST_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servidor no inicio a tiempo. ${stderr}`)), 8_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor termino con codigo ${code}. ${stderr}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });

  return { baseUrl, child, stderr: () => stderr };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json();
  return { response, payload };
}

test('el portal estatico usa rutas desplegables y una composicion HyperFrames valida', async () => {
  const [index, app, composition, timeline, packageJson] = await Promise.all([
    readFile(join(ROOT, 'index.html'), 'utf8'),
    readFile(join(ROOT, 'app.js'), 'utf8'),
    readFile(join(ROOT, 'assets', 'hyperframes-showcase.html'), 'utf8'),
    readFile(join(ROOT, 'assets', 'hyperframes-showcase.js'), 'utf8'),
    readFile(join(ROOT, 'package.json'), 'utf8'),
  ]);
  const pkg = JSON.parse(packageJson);

  assert.doesNotMatch(index, /__APP_VERSION__|(?:href|src)="\/(?:styles\.css|app\.js)/);
  assert.match(index, new RegExp(`app\\.js\\?v=${pkg.version.replaceAll('.', '\\.')}"`));
  assert.match(app, /new URL\('\.\/api\/', document\.baseURI\)/);
  assert.match(composition, /data-composition-id="agent-hub-showcase"/);
  assert.match(composition, /data-start-time="0"/);
  assert.match(composition, /hyperframes-showcase\.js/);
  assert.doesNotMatch(composition, /<style>|<script>(?:.|\n)*<\/script>/);
  assert.match(timeline, /gsap\.timeline\(\{ paused: true \}\)/);
  assert.match(timeline, /window\.__timelines\[compositionId\]/);
});

test('la API protege datos, sesiones, tipos de contenido y recursos entre cuentas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-test-'));
  const dataFile = join(directory, 'db.json');
  const running = await startServer(dataFile);

  try {
    const version = await jsonRequest(running.baseUrl, '/api/version');
    assert.equal(version.response.status, 200);
    assert.equal(version.payload.version, '1.19.0');

    const head = await fetch(`${running.baseUrl}/styles.css`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const font = await fetch(`${running.baseUrl}/assets/hanken-grotesk-latin-400-normal-BG6hkEXj.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');

    const privateData = await jsonRequest(running.baseUrl, '/data/db.json');
    assert.equal(privateData.response.status, 403);

    const malformedCookie = await jsonRequest(running.baseUrl, '/api/me', { headers: { Cookie: `${encodeURIComponent('x')}=%E0%A4%A` } });
    assert.equal(malformedCookie.response.status, 401);

    const unsupported = await jsonRequest(running.baseUrl, '/api/register', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(unsupported.response.status, 415);

    const crossSite = await jsonRequest(running.baseUrl, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'evil@example.com', password: 'correct-horse-battery' }),
    });
    assert.equal(crossSite.response.status, 403);

    const firstRegistration = await jsonRequest(running.baseUrl, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'one@example.com', password: 'correct-horse-battery' }),
    });
    assert.equal(firstRegistration.response.status, 201);
    const firstCookie = firstRegistration.response.headers.get('set-cookie').split(';')[0];

    const agentResult = await jsonRequest(running.baseUrl, '/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ name: 'Research Scout', description: 'Busca evidencia', category: 'Research' }),
    });
    assert.equal(agentResult.response.status, 201);

    const conversationResult = await jsonRequest(running.baseUrl, `/api/agents/${agentResult.payload.agent.id}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ title: 'Prueba aislada' }),
    });
    assert.equal(conversationResult.response.status, 201);

    const badRole = await jsonRequest(running.baseUrl, `/api/conversations/${conversationResult.payload.conversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ role: 'owner', content: 'No permitido' }),
    });
    assert.equal(badRole.response.status, 400);

    const message = await jsonRequest(running.baseUrl, `/api/conversations/${conversationResult.payload.conversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ role: 'user', content: 'Hola' }),
    });
    assert.equal(message.response.status, 201);

    const secondRegistration = await jsonRequest(running.baseUrl, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'two@example.com', password: 'another-correct-password' }),
    });
    assert.equal(secondRegistration.response.status, 201);
    const secondCookie = secondRegistration.response.headers.get('set-cookie').split(';')[0];

    const foreignMessages = await jsonRequest(running.baseUrl, `/api/conversations/${conversationResult.payload.conversation.id}/messages`, { headers: { Cookie: secondCookie } });
    assert.equal(foreignMessages.response.status, 404);

    const missingDelete = await jsonRequest(running.baseUrl, '/api/agents/99999', { method: 'DELETE', headers: { Cookie: firstCookie } });
    assert.equal(missingDelete.response.status, 404);
  } finally {
    await stopServer(running.child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('un archivo de datos corrupto impide el arranque sin ser sobrescrito', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-corrupt-'));
  const dataFile = join(directory, 'db.json');
  const original = '{ esto no es json';
  await writeFile(dataFile, original, 'utf8');

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_FILE: dataFile, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));

  assert.notEqual(exitCode, 0);
  assert.equal(await readFile(dataFile, 'utf8'), original);
  await rm(directory, { recursive: true, force: true });
});
