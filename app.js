const appEl = document.getElementById('app');

const state = {
  loading: true,
  mode: 'login',
  user: null,
  agents: [],
  conversations: [],
  messages: [],
  selectedAgentId: null,
  selectedConversationId: null,
  feedback: '',
};

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((error) => {
    state.feedback = error.message || 'No se pudo iniciar la aplicación';
    state.loading = false;
    render();
  });
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setLoading(next) {
  state.loading = next;
  render();
}

function setFeedback(message, kind = 'error') {
  state.feedback = message ? `${kind}:${message}` : '';
  render();
}

function parseFeedback() {
  if (!state.feedback) return '';
  const idx = state.feedback.indexOf(':');
  if (idx < 0) return '';
  const kind = state.feedback.slice(0, idx);
  const text = state.feedback.slice(idx + 1);
  return `<div class="feedback ${kind}">${escapeHtml(text)}</div>`;
}

function toDate(value) {
  try {
    const d = new Date(value);
    return d.toLocaleString('es-ES', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

function selectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedAgentId) || null;
}

function selectedConversation() {
  return state.conversations.find((conv) => conv.id === state.selectedConversationId) || null;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const payload =
    contentType.includes('application/json') ? await res.json() : { message: await res.text() };
  if (!res.ok) throw new Error(payload.error || payload.message || `HTTP ${res.status}`);
  return payload;
}

async function boot() {
  await hydrateSession();
  setLoading(false);
}

async function hydrateSession() {
  try {
    const me = await apiFetch('/api/me');
    state.user = me.user;
    state.feedback = '';
    await Promise.all([loadAgents()]);
    return;
  } catch {
    state.user = null;
    state.agents = [];
    state.conversations = [];
    state.messages = [];
    state.selectedAgentId = null;
    state.selectedConversationId = null;
  }
}

async function loadAgents() {
  state.agents = await apiFetch('/api/agents');
  state.selectedAgentId = state.agents[0]?.id || null;
  if (state.selectedAgentId) await loadConversationsForAgent(state.selectedAgentId);
}

async function loadConversationsForAgent(agentId) {
  state.conversations = await apiFetch(`/api/agents/${agentId}/conversations`);
  if (!state.conversations.some((conv) => conv.id === state.selectedConversationId)) {
    state.selectedConversationId = state.conversations[0]?.id || null;
  }
  if (state.selectedConversationId) {
    await loadMessages(state.selectedConversationId);
  } else {
    state.messages = [];
  }
}

async function loadMessages(conversationId) {
  const payload = await apiFetch(`/api/conversations/${conversationId}/messages`);
  state.messages = payload.messages || [];
}

function render() {
  if (state.loading) {
    appEl.innerHTML = '<section class="card loading">Cargando...</section>';
    return;
  }

  appEl.innerHTML = state.user ? renderDashboard() : renderAuth();
  attachEvents();
}

function renderAuth() {
  return `
    <section class="app-shell">
      <section class="auth-wrap">
        <article class="card">
          <h1>Agent Hub</h1>
          <p class="subtitle">Gestiona tus agentes y conversaciones desde cualquier dispositivo.</p>
          <div class="tabs">
            <button class="tab ${state.mode === 'login' ? 'active' : ''}" id="tab-login" type="button">Iniciar sesión</button>
            <button class="tab ${state.mode === 'register' ? 'active' : ''}" id="tab-register" type="button">Crear cuenta</button>
          </div>
          ${parseFeedback()}
          <form class="panel active" id="login-form" style="display:${state.mode === 'login' ? 'block' : 'none'}">
            <label>Correo
              <input name="email" type="email" required autocomplete="username" />
            </label>
            <label>Contraseña
              <input name="password" type="password" minlength="10" required autocomplete="current-password" />
            </label>
            <button type="submit">Entrar</button>
          </form>
          <form class="panel" id="register-form" style="display:${state.mode === 'register' ? 'block' : 'none'}">
            <label>Nombre
              <input name="name" type="text" required />
            </label>
            <label>Correo
              <input name="email" type="email" required autocomplete="email" />
            </label>
            <label>Contraseña
              <input name="password" type="password" minlength="10" required autocomplete="new-password" />
            </label>
            <button type="submit">Crear cuenta</button>
          </form>
          <small>Contraseña mínima: 10 caracteres.</small>
        </article>
      </section>
    </section>
  `;
}

function renderDashboard() {
  const agentMarkup = state.agents
    .map((agent) => {
      const selected = agent.id === state.selectedAgentId ? ' selected' : '';
      return `<li><button class="list-item${selected}" data-agent="${agent.id}">${escapeHtml(agent.name)}</button></li>`;
    })
    .join('');

  const conversationMarkup = state.conversations
    .map((conversation) => {
      const selected = conversation.id === state.selectedConversationId ? ' selected' : '';
      return `<li><button class="list-item${selected}" data-conversation="${conversation.id}">${escapeHtml(
        conversation.title,
      )}<span>${conversation.messageCount} mensajes</span></button></li>`;
    })
    .join('');

  const messageMarkup = state.messages
    .map(
      (msg) => `
    <li class="message ${msg.role}">
      <strong>${escapeHtml(msg.role.toUpperCase())}:</strong>
      <p>${escapeHtml(msg.content)}</p>
      <time>${toDate(msg.createdAt)}</time>
    </li>
  `,
    )
    .join('');

  const currentAgent = selectedAgent();
  const currentConversation = selectedConversation();

  return `
    <section class="app-shell">
      <header class="topbar">
        <div>
          <h1>Agent Hub</h1>
          <small>${escapeHtml(state.user.email)} · ${escapeHtml(state.user.name)}</small>
        </div>
        <button id="logout-button" type="button">Cerrar sesión</button>
      </header>

      <section class="grid">
        <aside class="card side-panel">
          <h2>Agentes</h2>
          <form id="agent-form">
            <label>Nombre del agente
              <input name="name" maxlength="80" required />
            </label>
            <label>Modelo
              <input name="model" maxlength="60" value="gpt-4o-mini" />
            </label>
            <label>Instrucciones
              <textarea name="instructions" maxlength="500" rows="3"></textarea>
            </label>
            <button type="submit">Crear agente</button>
          </form>
          <ul class="list">${agentMarkup || '<li class="empty">Sin agentes todavía.</li>'}</ul>
        </aside>

        <main class="card main-panel">
          <h2>Conversaciones ${currentAgent ? `- ${escapeHtml(currentAgent.name)}` : ''}</h2>
          ${state.selectedAgentId
            ? `<form id="conversation-form">
                 <label>Título
                   <input name="title" required />
                 </label>
                 <button type="submit">Nueva conversación</button>
               </form>
               <ul class="list">${conversationMarkup || '<li class="empty">Sin conversaciones para este agente.</li>'}</ul>`
            : '<p class="empty">Crea un agente para empezar.</p>'}
        </main>

        <section class="card message-panel">
          <h2>${currentConversation ? escapeHtml(currentConversation.title) : 'Mensajes'}</h2>
          ${currentConversation ? `<p class="meta">Agente: ${escapeHtml(currentAgent?.name || '')}</p>` : ''}
          <ul class="message-list">${messageMarkup || '<li class="empty">Aún sin mensajes.</li>'}</ul>
          ${currentConversation
            ? `<form id="message-form">
                 <label>Mensaje
                   <textarea name="content" rows="4" required></textarea>
                 </label>
                 <div class="row">
                   <select name="role">
                     <option value="user">Usuario</option>
                     <option value="assistant">Asistente</option>
                     <option value="system">Sistema</option>
                   </select>
                   <button type="submit">Enviar</button>
                 </div>
               </form>`
            : ''}
        </section>
      </section>
      ${parseFeedback()}
    </section>
  `;
}

function attachEvents() {
  if (!state.user) {
    const loginBtn = document.getElementById('tab-login');
    const registerBtn = document.getElementById('tab-register');
    if (loginBtn) {
      loginBtn.onclick = () => {
        state.mode = 'login';
        state.feedback = '';
        render();
      };
    }
    if (registerBtn) {
      registerBtn.onclick = () => {
        state.mode = 'register';
        state.feedback = '';
        render();
      };
    }
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    if (loginForm) {
      loginForm.onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fd = new FormData(form);
        setLoading(true);
        try {
          state.user = await apiFetch('/api/login', {
            method: 'POST',
            body: {
              email: fd.get('email'),
              password: fd.get('password'),
            },
          }).then((payload) => payload.user);
          await hydrateSession();
          state.feedback = '';
          setLoading(false);
        } catch (error) {
          setFeedback(`error:${error.message}`);
          setLoading(false);
        }
      };
    }

    if (registerForm) {
      registerForm.onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fd = new FormData(form);
        setLoading(true);
        try {
          state.user = await apiFetch('/api/register', {
            method: 'POST',
            body: {
              name: fd.get('name'),
              email: fd.get('email'),
              password: fd.get('password'),
            },
          }).then((payload) => payload.user);
          await hydrateSession();
          state.feedback = '';
          setLoading(false);
        } catch (error) {
          setFeedback(`error:${error.message}`);
          setLoading(false);
        }
      };
    }

    return;
  }

  const logoutButton = document.getElementById('logout-button');
  if (logoutButton) {
    logoutButton.onclick = async () => {
      setLoading(true);
      try {
        await apiFetch('/api/logout', { method: 'POST' });
      } catch {
        // no-op
      } finally {
        state.user = null;
        state.feedback = '';
        state.agents = [];
        state.conversations = [];
        state.messages = [];
        state.selectedAgentId = null;
        state.selectedConversationId = null;
        setLoading(false);
      }
    };
  }

  document.querySelectorAll('[data-agent]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedConversationId = null;
      state.messages = [];
      state.selectedAgentId = Number(button.dataset.agent);
      setLoading(true);
      await loadConversationsForAgent(state.selectedAgentId);
      setLoading(false);
    });
  });

  document.querySelectorAll('[data-conversation]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedConversationId = Number(button.dataset.conversation);
      setLoading(true);
      await loadMessages(state.selectedConversationId);
      setLoading(false);
    });
  });

  const agentForm = document.getElementById('agent-form');
  if (agentForm) {
    agentForm.onsubmit = async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      setLoading(true);
      try {
        await apiFetch('/api/agents', {
          method: 'POST',
          body: {
            name: fd.get('name'),
            model: fd.get('model'),
            instructions: fd.get('instructions'),
          },
        });
        await loadAgents();
        setFeedback('success:Agente creado.');
        setLoading(false);
      } catch (error) {
        setFeedback(`error:${error.message}`);
        setLoading(false);
      }
    };
  }

  const conversationForm = document.getElementById('conversation-form');
  if (conversationForm && state.selectedAgentId) {
    conversationForm.onsubmit = async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      setLoading(true);
      try {
        const conv = await apiFetch('/api/conversations', {
          method: 'POST',
          body: { title: fd.get('title'), agentId: state.selectedAgentId },
        });
        state.selectedConversationId = conv.id;
        await loadConversationsForAgent(state.selectedAgentId);
        setFeedback('success:Conversación creada.');
        setLoading(false);
      } catch (error) {
        setFeedback(`error:${error.message}`);
        setLoading(false);
      }
    };
  }

  const messageForm = document.getElementById('message-form');
  if (messageForm && state.selectedConversationId) {
    messageForm.onsubmit = async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const content = String(fd.get('content') || '').trim();
      const role = fd.get('role');
      if (!content) return;
      setLoading(true);
      try {
        await apiFetch(`/api/conversations/${state.selectedConversationId}/messages`, {
          method: 'POST',
          body: { role, content },
        });
        event.currentTarget.reset();
        await loadConversationsForAgent(state.selectedAgentId);
        setLoading(false);
      } catch (error) {
        setFeedback(`error:${error.message}`);
        setLoading(false);
      }
    };
  }

  state.feedback = '';
}

render();
