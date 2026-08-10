(() => {
  'use strict';

  const root = document.getElementById('app');
  if (!root) return;

  const currentVersion = document.querySelector('meta[name="app-version"]')?.content || 'unknown';
  const initialMarkup = root.innerHTML;
  const waitingPattern = /(?:preparando agent hub|cargando)/i;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = `./assets/boot-guard.css?v=${encodeURIComponent(currentVersion)}`;
  document.head.append(stylesheet);

  function isStillWaiting() {
    return root.innerHTML === initialMarkup || waitingPattern.test(root.textContent || '');
  }

  function appendTextElement(parent, tagName, text, className) {
    const element = document.createElement(tagName);
    element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function reloadFresh() {
    const url = new URL(window.location.href);
    url.searchParams.set('refresh', Date.now().toString(36));
    window.location.replace(url.href);
  }

  function showRecovery() {
    if (!isStillWaiting()) return;

    const panel = document.createElement('main');
    panel.className = 'boot-recovery';
    panel.setAttribute('aria-live', 'polite');
    appendTextElement(panel, 'span', 'AGENT HUB / RECOVERY', 'boot-recovery__eyebrow');
    appendTextElement(panel, 'h1', 'La vista tardo mas de lo esperado.', 'boot-recovery__title');
    appendTextElement(
      panel,
      'p',
      'No se cargo ningun dato privado. Puedes solicitar la version mas reciente de la pagina de forma segura.',
      'boot-recovery__copy',
    );

    const actions = document.createElement('div');
    actions.className = 'boot-recovery__actions';
    const refresh = appendTextElement(actions, 'button', 'Actualizar ahora', 'boot-recovery__button');
    refresh.type = 'button';
    refresh.addEventListener('click', reloadFresh);

    const source = appendTextElement(actions, 'a', 'Estado del codigo', 'boot-recovery__link');
    source.href = 'https://github.com/JagoGG/agent-hub-web';
    source.target = '_blank';
    source.rel = 'noreferrer noopener';
    panel.append(actions);
    root.replaceChildren(panel);
  }

  async function alignRelease() {
    try {
      const response = await fetch(`./version.json?t=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) return;

      const payload = await response.json();
      const latestVersion = typeof payload.version === 'string' ? payload.version : '';
      if (!latestVersion || latestVersion === currentVersion) return;

      const reloadKey = 'agent-hub-release-reload';
      if (window.sessionStorage.getItem(reloadKey) === latestVersion) return;
      window.sessionStorage.setItem(reloadKey, latestVersion);

      const url = new URL(window.location.href);
      url.searchParams.set('release', latestVersion);
      window.location.replace(url.href);
    } catch (error) {
      console.info('Agent Hub release check unavailable; continuing with the cached page.', error);
    }
  }

  window.setTimeout(showRecovery, 8000);
  window.addEventListener('error', () => window.setTimeout(showRecovery, 0), { once: true });
  window.addEventListener('unhandledrejection', () => window.setTimeout(showRecovery, 0), { once: true });
  void alignRelease();
})();
