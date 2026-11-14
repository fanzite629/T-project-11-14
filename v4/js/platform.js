/* Storage and model transport. The UI talks only to window.TPlanPlatform, so the same pages run
   in a plain browser (localStorage + fetch) and inside the Windows WebView2 shell (SQLite + native HTTP). */
(function () {
  'use strict';

  const STATE_KEY = 'tplan.v4';
  const SECRET_KEY = 'tplan.v4.secret';
  const TIMEOUT_MS = 65000;
  const webview = window.chrome && window.chrome.webview;
  const isDesktop = !!(webview && webview.hostObjects);

  /* ---------- browser ---------- */
  const browser = {
    name: 'browser',
    loadState: () => localStorage.getItem(STATE_KEY) || '',
    saveState: (json) => localStorage.setItem(STATE_KEY, json),
    loadSecret: () => localStorage.getItem(SECRET_KEY) || '',
    saveSecret: (value) => (value ? localStorage.setItem(SECRET_KEY, value) : localStorage.removeItem(SECRET_KEY)),
    async chat(agent, system, user) {
      const anthropic = agent.provider === 'anthropic';
      const url = anthropic ? 'https://api.anthropic.com/v1/messages' : agent.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const key = browser.loadSecret();
      const headers = { 'content-type': 'application/json' };
      let body;
      if (anthropic) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        body = { model: agent.modelId, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] };
      } else {
        if (key) headers.authorization = 'Bearer ' + key;
        body = { model: agent.modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      }
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: control.signal });
      } catch {
        throw new Error('无法连接模型服务，请检查接口地址和网络。');
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error('模型服务返回 HTTP ' + response.status + '，请检查地址、密钥和模型名称。');
      const data = await response.json();
      if (anthropic) return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return (((data.choices || [])[0] || {}).message || {}).content || '';
    },
  };

  /* ---------- Windows shell (same bridge contract as v3-desktop: Database host object + ai-request messages).
     The shell reads the model settings from the saved state and keeps the API key encrypted with DPAPI. ---------- */
  function desktopPlatform() {
    const db = webview.hostObjects.sync.database;
    const SHELL_KEY = 'tplan.v3'; // the only state key the existing shell accepts
    const pending = new Map();
    webview.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || m.kind !== 'ai-response') return;
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.text);
    });
    return {
      name: 'desktop',
      loadState: () => db.Read(SHELL_KEY),
      saveState: (json) => db.Write(SHELL_KEY, json),
      loadSecret: () => db.ReadSecret(),
      saveSecret: (value) => db.WriteSecret(value || ''),
      chat(agent, system, user) {
        const id = 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            webview.postMessage({ kind: 'ai-cancel', id });
            reject(new Error('请求超时，请检查模型服务后重试。'));
          }, TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          webview.postMessage({ kind: 'ai-request', id, system, user });
        });
      },
    };
  }

  window.TPlanPlatform = isDesktop ? desktopPlatform() : browser;
})();
