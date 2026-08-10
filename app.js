const appEl = document.getElementById('app');

if (!appEl) {
  throw new Error('No se encontro el contenedor principal de Agent Hub.');
}

const API_BASE = new URL('./api/', document.baseURI);
const REPOSITORY_URL = 'https://github.com/JagoGG/agent-hub-web';
const HYPERFRAMES_URL = 'https://github.com/heygen-com/hyperframes';
const metaVersion =
  document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '1.21.0';

const state = {
  loading: true,
  busy: false,
  fatalError: '',
  backendAvailable: null,
  backendIssue: '',
  mode: 'login',
  user: null,
  agents: [],
  conversations: [],
  messages: [],
  selectedAgentId: null,
  selectedConversationId: null,
  appVersion: normalizeVersion(metaVersion),
  appStartedAt: '',
  feedback: null,
  drafts: {
    loginEmail: '',
    registerName: '',
    registerEmail: '',
    agentName: '',
    agentModel: 'gpt-4o-mini',
    agentInstructions: '',
    conversationTitle: '',
    messageContent: '',
  },
};

let playerDefinitionTimer = null;

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeVersion(value) {
  return String(value || 'desconocida')
    .trim()
    .replace(/^v/i, '');
}

function formatVersion(value) {
  const version = normalizeVersion(value);
  return version === 'desconocida' ? version : `v${version}`;
}

function normalizeMessageRole(value) {
  const role = String(value || '').toLowerCase();
  return role === 'assistant' || role === 'system' || role === 'user' ? role : 'user';
}

function toDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleString('es-ES', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function selectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedAgentId) || null;
}

function selectedConversation() {
  return (
    state.conversations.find(
      (conversation) => conversation.id === state.selectedConversationId,
    ) || null
  );
}

function setFeedback(message, kind = 'error') {
  state.feedback = message ? { kind, message: String(message) } : null;
}

function renderFeedback() {
  if (!state.feedback) return '';
  const allowedKinds = new Set(['error', 'success', 'warning', 'info']);
  const kind = allowedKinds.has(state.feedback.kind) ? state.feedback.kind : 'info';
  return `
    <div class="feedback ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
      <span class="feedback-mark" aria-hidden="true"></span>
      <p>${escapeHtml(state.feedback.message)}</p>
    </div>
  `;
}

async function apiFetch(endpoint, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 7000);
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(
      new URL(String(endpoint).replace(/^\/+/, ''), API_BASE),
      {
        method,
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      },
    );

    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const message =
        payload?.error ||
        payload?.message ||
        (response.status === 404
          ? 'El servicio solicitado no esta disponible.'
          : `Error HTTP ${response.status}`);
      throw new ApiError(message, response.status);
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('El servidor tardo demasiado en responder.');
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError('No se pudo conectar con el servidor de Agent Hub.');
  } finally {
    window.clearTimeout(timeout);
  }
}

async function hydrateAppInfo() {
  try {
    const info = await apiFetch('version', { timeoutMs: 4500 });
    state.backendAvailable = true;
    state.backendIssue = '';
    state.appVersion = normalizeVersion(info?.version || state.appVersion);
    state.appStartedAt = String(info?.startedAt || '');
    return true;
  } catch (error) {
    state.backendAvailable = false;
    state.backendIssue = error.message;
    return false;
  }
}

function clearSessionState() {
  state.user = null;
  state.agents = [];
  state.conversations = [];
  state.messages = [];
  state.selectedAgentId = null;
  state.selectedConversationId = null;
}

async function hydrateSession() {
  try {
    const payload = await apiFetch('me');
    state.user = payload.user;
    await loadAgents();
  } catch (error) {
    clearSessionState();
    if (error.status !== 401) {
      setFeedback('El servidor esta activo, pero no pudo recuperar la sesion.', 'warning');
    }
  }
}

async function loadAgents() {
  const previousAgentId = state.selectedAgentId;
  const payload = await apiFetch('agents');
  state.agents = Array.isArray(payload?.agents) ? payload.agents : [];
  state.selectedAgentId = state.agents.some((agent) => agent.id === previousAgentId)
    ? previousAgentId
    : state.agents[0]?.id || null;

  if (state.selectedAgentId) {
    await loadConversationsForAgent(state.selectedAgentId);
  } else {
    state.conversations = [];
    state.messages = [];
    state.selectedConversationId = null;
  }
}

async function loadConversationsForAgent(agentId) {
  const previousConversationId = state.selectedConversationId;
  const payload = await apiFetch(`agents/${agentId}/conversations`);
  state.conversations = Array.isArray(payload?.conversations) ? payload.conversations : [];
  state.selectedConversationId = state.conversations.some(
    (conversation) => conversation.id === previousConversationId,
  )
    ? previousConversationId
    : state.conversations[0]?.id || null;

  if (state.selectedConversationId) {
    await loadMessages(state.selectedConversationId);
  } else {
    state.messages = [];
  }
}

async function loadMessages(conversationId) {
  const payload = await apiFetch(`conversations/${conversationId}/messages`);
  state.messages = Array.isArray(payload?.messages) ? payload.messages : [];
}

async function boot() {
  const backendOnline = await hydrateAppInfo();
  if (backendOnline) await hydrateSession();
  state.loading = false;
  render();
}

function startBoot() {
  state.loading = true;
  state.fatalError = '';
  render();
  boot().catch((error) => {
    state.loading = false;
    state.fatalError = error?.message || 'No se pudo iniciar Agent Hub.';
    render();
  });
}

function renderLoading() {
  return `
    <main class="status-page">
      <section class="status-panel" aria-live="polite">
        <span class="status-index">AH / BOOT</span>
        <div class="loading-line" aria-hidden="true"><span></span></div>
        <h1>Preparando Agent Hub</h1>
        <p>Comprobando la experiencia publica y el servidor operativo.</p>
      </section>
    </main>
  `;
}

function renderFatalError() {
  return `
    <main class="status-page">
      <section class="status-panel status-panel-error">
        <span class="status-index">AH / ERROR</span>
        <h1>No pudimos iniciar la interfaz</h1>
        <p>${escapeHtml(state.fatalError)}</p>
        <button class="button button-primary" id="retry-boot" type="button">
          Intentar de nuevo
        </button>
      </section>
    </main>
  `;
}

function renderPortal() {
  const backendOnline = state.backendAvailable === true;
  const versionText = escapeHtml(formatVersion(state.appVersion));
  const statusLabel = backendOnline ? 'Servidor operativo' : 'Preview publico';
  const primaryHref = backendOnline ? '#access' : '#experience';
  const primaryLabel = backendOnline ? 'Entrar al workspace' : 'Ver la experiencia';
  const graphStatusLabel = backendOnline ? 'API ONLINE' : 'STATIC READY';

  return `
    <main class="public-shell">
      <header class="masthead">
        <div class="site-width masthead-inner">
          <a class="brand" href="./" aria-label="Agent Hub, inicio">
            <img src="./brand/agent-hub-isotype.png" alt="" width="42" height="42" />
            <span>
              <strong>Agent Hub</strong>
              <small>Continuity workspace</small>
            </span>
          </a>
          <nav class="main-nav" aria-label="Navegacion principal">
            <a href="#system">Sistema</a>
            <a href="#experience">HyperFrames</a>
            <a href="#access">Acceso</a>
          </nav>
          <a class="repo-link" href="${REPOSITORY_URL}" target="_blank" rel="noreferrer noopener">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <section class="hero site-width">
        <div class="hero-copy">
          <div class="hero-status">
            <span class="status-light" aria-hidden="true"></span>
            <span>${statusLabel}</span>
            <span class="version-inline">${versionText}</span>
          </div>
          <p class="eyebrow">Agents / conversations / continuity</p>
          <h1>Un centro de mando para agentes que <em>no empiezan de cero.</em></h1>
          <p class="hero-lead">
            Reune agentes, conversaciones y contexto operativo en una sola superficie.
            La informacion permanece ordenada por usuario y lista para continuar.
          </p>
          <div class="hero-actions">
            <a class="button button-primary" href="${primaryHref}">
              ${primaryLabel}<span aria-hidden="true">→</span>
            </a>
            <a class="button button-secondary" href="#system">Explorar el sistema</a>
          </div>
          <dl class="hero-facts" aria-label="Capacidades principales">
            <div><dt>01</dt><dd>Agentes aislados por usuario</dd></div>
            <div><dt>02</dt><dd>Historial con continuidad</dd></div>
            <div><dt>03</dt><dd>Interfaz movil y escritorio</dd></div>
          </dl>
        </div>

        <figure class="signal-graph" aria-labelledby="signal-graph-title">
          <figcaption class="graph-header">
            <span id="signal-graph-title">LIVE CONTINUITY GRAPH</span>
            <span><i aria-hidden="true"></i>${graphStatusLabel}</span>
          </figcaption>
          <div class="graph-canvas">
            <svg class="graph-links" viewBox="0 0 520 400" aria-hidden="true">
              <circle class="graph-orbit" cx="260" cy="200" r="104"></circle>
              <path class="graph-link graph-link-a" d="M260 200 C218 158 168 112 92 72"></path>
              <path class="graph-link graph-link-b" d="M260 200 C302 158 352 112 428 72"></path>
              <path class="graph-link graph-link-c" d="M260 200 C302 242 352 288 428 328"></path>
              <path class="graph-link graph-link-d" d="M260 200 C218 242 168 288 92 328"></path>
            </svg>
            <div class="graph-core">
              <span>AH / 00</span>
              <strong>Agent Hub</strong>
              <small>Continuidad central</small>
              <i>${backendOnline ? 'LIVE' : 'DEMO'}</i>
            </div>
            <article class="graph-node graph-node-agent">
              <span>01 / IDENTITY</span>
              <strong>Agentes</strong>
              <small>Modelo + reglas</small>
            </article>
            <article class="graph-node graph-node-thread">
              <span>02 / THREADS</span>
              <strong>Conversaciones</strong>
              <small>Contexto por agente</small>
            </article>
            <article class="graph-node graph-node-message">
              <span>03 / SIGNAL</span>
              <strong>Mensajes</strong>
              <small>Secuencia ordenada</small>
            </article>
            <article class="graph-node graph-node-memory">
              <span>04 / MEMORY</span>
              <strong>Continuidad</strong>
              <small>Estado persistente</small>
            </article>
          </div>
          <div class="graph-readout" aria-label="Estado del sistema">
            <span><i aria-hidden="true"></i> 04 nodos</span>
            <span><i aria-hidden="true"></i> 04 rutas</span>
            <span><i aria-hidden="true"></i> 01 contexto</span>
          </div>
          <p class="graph-caption">Cada senal vuelve al mismo contexto operativo.</p>
        </figure>
      </section>

      <section class="system-section" id="system">
        <div class="site-width">
          <header class="section-heading">
            <span class="section-number">01</span>
            <div>
              <p class="eyebrow">Arquitectura de continuidad</p>
              <h2>Menos reinicios. Mas trabajo conectado.</h2>
            </div>
          </header>
          <div class="capability-index">
            <article>
              <span class="capability-number">01</span>
              <h3>Agentes con identidad</h3>
              <p>Nombre, modelo e instrucciones permanecen juntos y bajo la cuenta correcta.</p>
              <span class="capability-tag">IDENTITY</span>
            </article>
            <article>
              <span class="capability-number">02</span>
              <h3>Conversaciones legibles</h3>
              <p>Cada hilo conserva su agente, sus mensajes y el orden temporal de trabajo.</p>
              <span class="capability-tag">THREADS</span>
            </article>
            <article>
              <span class="capability-number">03</span>
              <h3>Persistencia defensiva</h3>
              <p>Las escrituras del servidor se realizan de forma atomica para proteger el estado.</p>
              <span class="capability-tag">STATE</span>
            </article>
          </div>
        </div>
      </section>

      <section class="continuity-band" aria-label="Flujo resumido">
        <div class="site-width continuity-track">
          <span>DEFINE</span><i aria-hidden="true"></i>
          <span>CONVERSA</span><i aria-hidden="true"></i>
          <span>CONSERVA</span><i aria-hidden="true"></i>
          <span>CONTINUA</span>
        </div>
      </section>

      ${renderHyperframesSection()}
      ${renderAccessSection(backendOnline)}

      <footer class="site-footer">
        <div class="site-width footer-inner">
          <div class="footer-brand">
            <img src="./brand/agent-hub-isotype.png" alt="" width="36" height="36" />
            <div><strong>Agent Hub</strong><span>Built for continuous agent work.</span></div>
          </div>
          <p>Portal publico y servidor local en un mismo repositorio.</p>
          <a href="${REPOSITORY_URL}" target="_blank" rel="noreferrer noopener">Ver codigo fuente ↗</a>
        </div>
      </footer>
    </main>
  `;
}

function renderHyperframesSection() {
  return `
    <section class="experience-section" id="experience">
      <div class="site-width experience-grid">
        <header class="section-heading experience-heading">
          <span class="section-number">02</span>
          <div>
            <p class="eyebrow">Motion layer / HeyGen HyperFrames</p>
            <h2>El flujo se entiende antes de leerlo.</h2>
            <p>
              Una composicion HTML controlable traduce agentes, conversaciones y continuidad
              en una secuencia visual reproducible.
            </p>
            <a class="text-link" href="${HYPERFRAMES_URL}" target="_blank" rel="noreferrer noopener">
              Conocer HyperFrames <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>
        <div class="player-frame">
          <div class="player-chrome" aria-hidden="true">
            <span>AGENT HUB / FLOW 01</span><span>08.0 SEC</span>
          </div>
          <hyperframes-player
            id="agent-flow-player"
            src="./assets/hyperframes-showcase.html"
            width="1920"
            height="1080"
            controls
            muted
            audio-locked
            style="display:block;width:100%;aspect-ratio:16/9"
          >
            <div class="player-fallback">
              La composicion esta disponible en
              <a href="./assets/hyperframes-showcase.html">modo HTML</a>.
            </div>
          </hyperframes-player>
          <p class="player-status" id="player-status" aria-live="polite">
            Reproduccion bajo demanda. Sin audio.
          </p>
        </div>
      </div>
    </section>
  `;
}

function renderAccessSection(backendOnline) {
  return `
    <section class="access-section" id="access">
      <div class="site-width access-grid">
        <header class="section-heading access-heading">
          <span class="section-number">03</span>
          <div>
            <p class="eyebrow">${backendOnline ? 'Servidor conectado' : 'Publicacion estatica'}</p>
            <h2>${backendOnline ? 'Tu workspace esta listo.' : 'La vista publica esta activa.'}</h2>
            <p>
              ${backendOnline
                ? 'Inicia sesion o crea una cuenta para gestionar agentes y conversaciones.'
                : 'GitHub Pages muestra el producto a todo el mundo. Las cuentas requieren ejecutar el servidor Node, porque Pages no aloja bases de datos ni APIs.'}
            </p>
          </div>
        </header>
        ${backendOnline ? renderAuthPanel() : renderStaticAccessPanel()}
      </div>
    </section>
  `;
}

function renderStaticAccessPanel() {
  return `
    <aside class="static-access" role="note">
      <span class="panel-code">PUBLIC / ONLINE</span>
      <h3>Preview sin formularios rotos</h3>
      <p>
        Esta pagina funciona de forma estatica y no simula registros. El modo operativo se
        activa al iniciar <code>npm run start</code> en un servidor con almacenamiento persistente.
      </p>
      <div class="access-status-row">
        <span><i aria-hidden="true"></i> GitHub Pages disponible</span>
        <span>API no requerida</span>
      </div>
      <a class="button button-secondary" href="${REPOSITORY_URL}#ejecutar-localmente" target="_blank" rel="noreferrer noopener">
        Ver instrucciones
      </a>
    </aside>
  `;
}

function renderAuthPanel() {
  const loginActive = state.mode === 'login';
  const activeForm = loginActive
    ? `
      <form class="auth-form" id="login-form">
        <label>
          <span>Correo</span>
          <input name="email" type="email" maxlength="254" value="${escapeHtml(state.drafts.loginEmail)}" required autocomplete="username" />
        </label>
        <label>
          <span>Contrasena</span>
          <input name="password" type="password" minlength="10" maxlength="256" required autocomplete="current-password" />
        </label>
        <button class="button button-primary" type="submit">Entrar al workspace &rarr;</button>
      </form>
    `
    : `
      <form class="auth-form" id="register-form">
        <label>
          <span>Nombre</span>
          <input name="name" type="text" maxlength="80" value="${escapeHtml(state.drafts.registerName)}" required autocomplete="name" />
        </label>
        <label>
          <span>Correo</span>
          <input name="email" type="email" maxlength="254" value="${escapeHtml(state.drafts.registerEmail)}" required autocomplete="email" />
        </label>
        <label>
          <span>Contrasena</span>
          <input name="password" type="password" minlength="10" maxlength="256" required autocomplete="new-password" />
        </label>
        <button class="button button-primary" type="submit">Crear cuenta &rarr;</button>
      </form>
    `;

  return `
    <aside class="auth-panel">
      <span class="panel-code">SECURE SESSION / HTTPONLY</span>
      <div class="tabs" aria-label="Opciones de acceso">
        <button class="tab ${loginActive ? 'active' : ''}" id="tab-login" type="button" aria-pressed="${loginActive}">Ingresar</button>
        <button class="tab ${!loginActive ? 'active' : ''}" id="tab-register" type="button" aria-pressed="${!loginActive}">Crear cuenta</button>
      </div>
      ${renderFeedback()}
      ${activeForm}
      <p class="form-note">Minimo 10 caracteres. Maximo 256.</p>
    </aside>
  `;
}

function renderDashboard() {
  const currentAgent = selectedAgent();
  const currentConversation = selectedConversation();
  const versionText = escapeHtml(formatVersion(state.appVersion));

  const agentMarkup = state.agents
    .map((agent) => {
      const selected = agent.id === state.selectedAgentId;
      return `
        <li>
          <button
            class="list-item ${selected ? 'selected' : ''}"
            data-agent="${Number(agent.id)}"
            type="button"
            aria-current="${selected ? 'true' : 'false'}"
          >
            <span class="list-index">A${String(agent.id).padStart(2, '0')}</span>
            <span class="list-copy">
              <strong>${escapeHtml(agent.name)}</strong>
              <small>${escapeHtml(agent.model || 'Modelo sin definir')} · ${escapeHtml(agent.instructions || 'Sin instrucciones')}</small>
            </span>
          </button>
        </li>
      `;
    })
    .join('');

  const conversationMarkup = state.conversations
    .map((conversation) => {
      const selected = conversation.id === state.selectedConversationId;
      return `
        <li>
          <button
            class="list-item ${selected ? 'selected' : ''}"
            data-conversation="${Number(conversation.id)}"
            type="button"
            aria-current="${selected ? 'true' : 'false'}"
          >
            <span class="list-index">C${String(conversation.id).padStart(2, '0')}</span>
            <span class="list-copy">
              <strong>${escapeHtml(conversation.title)}</strong>
              <small>${Number(conversation.messageCount) || 0} mensajes</small>
            </span>
          </button>
        </li>
      `;
    })
    .join('');

  const messageMarkup = state.messages
    .map((message) => {
      const role = normalizeMessageRole(message.role);
      return `
        <li class="message ${role}">
          <header><strong>${escapeHtml(role.toUpperCase())}</strong><time>${escapeHtml(toDate(message.createdAt))}</time></header>
          <p>${escapeHtml(message.content)}</p>
        </li>
      `;
    })
    .join('');

  return `
    <main class="workspace-shell">
      <header class="workspace-header">
        <a class="brand" href="./" aria-label="Agent Hub, workspace">
          <img src="./brand/agent-hub-isotype.png" alt="" width="42" height="42" />
          <span><strong>Agent Hub</strong><small>Operational workspace</small></span>
        </a>
        <div class="workspace-identity">
          <span class="online-mark"><i aria-hidden="true"></i> ONLINE</span>
          <span>${escapeHtml(state.user.name || 'Usuario')}</span>
          <small>${escapeHtml(state.user.email)}</small>
        </div>
        <div class="workspace-actions">
          <span class="version-inline">${versionText}</span>
          <button class="button button-secondary" id="logout-button" type="button">Cerrar sesion</button>
        </div>
      </header>

      <div class="workspace-feedback">${renderFeedback()}</div>

      <section class="workspace-grid">
        <aside class="workspace-panel agent-panel">
          <header class="panel-heading">
            <span>01 / AGENTS</span>
            <strong>${state.agents.length}</strong>
          </header>
          <form class="compact-form" id="agent-form">
            <label>
              <span>Nombre del agente</span>
              <input name="name" maxlength="80" value="${escapeHtml(state.drafts.agentName)}" required />
            </label>
            <label>
              <span>Modelo</span>
              <input name="model" maxlength="60" value="${escapeHtml(state.drafts.agentModel)}" required />
            </label>
            <label>
              <span>Instrucciones</span>
              <textarea name="instructions" maxlength="2000" rows="3">${escapeHtml(state.drafts.agentInstructions)}</textarea>
            </label>
            <button class="button button-primary" type="submit">Crear agente</button>
          </form>
          <ul class="data-list">
            ${agentMarkup || '<li class="empty-state"><strong>Sin agentes</strong><span>Crea el primero para abrir un flujo.</span></li>'}
          </ul>
        </aside>

        <section class="workspace-panel conversation-panel">
          <header class="panel-heading">
            <span>02 / THREADS</span>
            <strong>${state.conversations.length}</strong>
          </header>
          ${currentAgent
            ? `
              <div class="active-context">
                <span>AGENTE ACTIVO</span>
                <strong>${escapeHtml(currentAgent.name)}</strong>
              </div>
              <form class="inline-form" id="conversation-form">
                <label>
                  <span>Nueva conversacion</span>
                  <input name="title" maxlength="120" value="${escapeHtml(state.drafts.conversationTitle)}" required />
                </label>
                <button class="button button-primary" type="submit">Crear</button>
              </form>
              <ul class="data-list conversation-list">
                ${conversationMarkup || '<li class="empty-state"><strong>Sin conversaciones</strong><span>Abre un hilo para este agente.</span></li>'}
              </ul>
            `
            : '<div class="empty-state empty-panel"><strong>Selecciona el punto de partida</strong><span>Crea un agente para habilitar conversaciones.</span></div>'}
        </section>

        <section class="workspace-panel message-panel">
          <header class="panel-heading">
            <span>03 / MESSAGES</span>
            <strong>${state.messages.length}</strong>
          </header>
          ${currentConversation
            ? `
              <div class="active-context">
                <span>CONVERSACION ACTIVA</span>
                <strong>${escapeHtml(currentConversation.title)}</strong>
              </div>
              <ul class="message-list">
                ${messageMarkup || '<li class="empty-state"><strong>Sin mensajes</strong><span>El contexto comenzara con tu primer mensaje.</span></li>'}
              </ul>
              <form class="message-form" id="message-form">
                <label>
                  <span>Mensaje</span>
                  <textarea name="content" maxlength="4000" rows="4" required>${escapeHtml(state.drafts.messageContent)}</textarea>
                </label>
                <div class="message-actions">
                  <label>
                    <span>Rol</span>
                    <select name="role">
                      <option value="user">Usuario</option>
                      <option value="assistant">Asistente</option>
                      <option value="system">Sistema</option>
                    </select>
                  </label>
                  <button class="button button-primary" type="submit">Guardar mensaje</button>
                </div>
              </form>
            `
            : '<div class="empty-state empty-panel"><strong>Contexto en espera</strong><span>Selecciona una conversacion para ver sus mensajes.</span></div>'}
        </section>
      </section>

      <footer class="workspace-trace">
        <span>USER ${String(state.user.id).padStart(3, '0')}</span>
        <span>AGENTS ${state.agents.length}</span>
        <span>THREADS ${state.conversations.length}</span>
        <span>MESSAGES ${state.messages.length}</span>
      </footer>
    </main>
  `;
}

function setDomBusy(next) {
  appEl.classList.toggle('is-busy', next);
  appEl.setAttribute('aria-busy', String(next));
  appEl
    .querySelectorAll('button[type="submit"], [data-agent], [data-conversation]')
    .forEach((control) => {
      control.disabled = next;
    });
}

async function executeAction(action) {
  if (state.busy) return;
  state.busy = true;
  setDomBusy(true);
  try {
    await action();
  } catch (error) {
    setFeedback(error?.message || 'La operacion no pudo completarse.', 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function attachPortalEvents() {
  const loginTab = document.getElementById('tab-login');
  const registerTab = document.getElementById('tab-register');
  loginTab?.addEventListener('click', () => {
    state.mode = 'login';
    setFeedback('');
    render();
  });
  registerTab?.addEventListener('click', () => {
    state.mode = 'register';
    setFeedback('');
    render();
  });

  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.drafts.loginEmail = String(formData.get('email') || '').trim();
    executeAction(async () => {
      const payload = await apiFetch('login', {
        method: 'POST',
        body: {
          email: state.drafts.loginEmail,
          password: formData.get('password'),
        },
      });
      state.user = payload.user;
      state.drafts.loginEmail = '';
      setFeedback('');
      await loadAgents();
    });
  });

  const registerForm = document.getElementById('register-form');
  registerForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.drafts.registerName = String(formData.get('name') || '').trim();
    state.drafts.registerEmail = String(formData.get('email') || '').trim();
    executeAction(async () => {
      const payload = await apiFetch('register', {
        method: 'POST',
        body: {
          name: state.drafts.registerName,
          email: state.drafts.registerEmail,
          password: formData.get('password'),
        },
      });
      state.user = payload.user;
      state.drafts.registerName = '';
      state.drafts.registerEmail = '';
      setFeedback('');
      await loadAgents();
    });
  });

  const player = document.getElementById('agent-flow-player');
  const playerStatus = document.getElementById('player-status');
  if (player && playerStatus) {
    player.addEventListener('ready', (event) => {
      const duration = Number(event.detail?.duration || 0);
      playerStatus.textContent = duration
        ? `Composicion lista: ${duration.toFixed(1)} segundos. Sin audio.`
        : 'Composicion lista. Sin audio.';
    });
    player.addEventListener('error', () => {
      playerStatus.textContent =
        'El reproductor no pudo iniciar. Abre la composicion HTML desde el enlace alternativo.';
      playerStatus.classList.add('error');
    });

    window.clearTimeout(playerDefinitionTimer);
    playerDefinitionTimer = window.setTimeout(() => {
      if (!window.customElements.get('hyperframes-player')) {
        playerStatus.textContent =
          'El reproductor externo no respondio. La composicion HTML sigue disponible.';
        playerStatus.classList.add('error');
      }
    }, 5000);
  }
}

function attachWorkspaceEvents() {
  document.getElementById('logout-button')?.addEventListener('click', () => {
    executeAction(async () => {
      let logoutWarning = '';
      try {
        await apiFetch('logout', { method: 'POST', body: {} });
      } catch {
        logoutWarning = 'La sesion local se cerro, pero el servidor no confirmo la revocacion.';
      }
      clearSessionState();
      setFeedback(logoutWarning, logoutWarning ? 'warning' : 'info');
    });
  });

  document.querySelectorAll('[data-agent]').forEach((button) => {
    button.addEventListener('click', () => {
      executeAction(async () => {
        state.selectedAgentId = Number(button.dataset.agent);
        state.selectedConversationId = null;
        state.messages = [];
        setFeedback('');
        await loadConversationsForAgent(state.selectedAgentId);
      });
    });
  });

  document.querySelectorAll('[data-conversation]').forEach((button) => {
    button.addEventListener('click', () => {
      executeAction(async () => {
        state.selectedConversationId = Number(button.dataset.conversation);
        setFeedback('');
        await loadMessages(state.selectedConversationId);
      });
    });
  });

  const agentForm = document.getElementById('agent-form');
  agentForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.drafts.agentName = String(formData.get('name') || '').trim();
    state.drafts.agentModel = String(formData.get('model') || '').trim();
    state.drafts.agentInstructions = String(formData.get('instructions') || '').trim();
    executeAction(async () => {
      await apiFetch('agents', {
        method: 'POST',
        body: {
          name: state.drafts.agentName,
          model: state.drafts.agentModel,
          instructions: state.drafts.agentInstructions,
        },
      });
      state.drafts.agentName = '';
      state.drafts.agentInstructions = '';
      await loadAgents();
      setFeedback('Agente creado correctamente.', 'success');
    });
  });

  const conversationForm = document.getElementById('conversation-form');
  conversationForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.drafts.conversationTitle = String(formData.get('title') || '').trim();
    executeAction(async () => {
      const payload = await apiFetch(`agents/${state.selectedAgentId}/conversations`, {
        method: 'POST',
        body: {
          title: state.drafts.conversationTitle,
        },
      });
      state.selectedConversationId = payload.conversation.id;
      state.drafts.conversationTitle = '';
      await loadConversationsForAgent(state.selectedAgentId);
      setFeedback('Conversacion creada.', 'success');
    });
  });

  const messageForm = document.getElementById('message-form');
  messageForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.drafts.messageContent = String(formData.get('content') || '').trim();
    if (!state.drafts.messageContent) {
      setFeedback('El mensaje no puede estar vacio.', 'error');
      render();
      return;
    }
    executeAction(async () => {
      await apiFetch(`conversations/${state.selectedConversationId}/messages`, {
        method: 'POST',
        body: {
          role: formData.get('role'),
          content: state.drafts.messageContent,
        },
      });
      state.drafts.messageContent = '';
      await loadConversationsForAgent(state.selectedAgentId);
      setFeedback('Mensaje guardado.', 'success');
    });
  });
}

function attachEvents() {
  document.getElementById('retry-boot')?.addEventListener('click', startBoot);
  if (state.loading || state.fatalError) return;
  if (state.user) {
    attachWorkspaceEvents();
  } else {
    attachPortalEvents();
  }
}

function render() {
  if (state.loading) {
    appEl.innerHTML = renderLoading();
  } else if (state.fatalError) {
    appEl.innerHTML = renderFatalError();
  } else if (state.user) {
    appEl.innerHTML = renderDashboard();
  } else {
    appEl.innerHTML = renderPortal();
  }
  attachEvents();
}

startBoot();
