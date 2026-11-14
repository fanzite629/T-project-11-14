/* Storage and model transport. The UI talks only to window.TPlanPlatform, so the same pages run
   in a plain browser (localStorage + fetch) and inside the Windows WebView2 shell (SQLite + native HTTP). */
(function () {
  'use strict';

  const P = window.TPlanProviders;
  const STATE_KEY = 'tplan.v4';
  const SECRET_KEY = 'tplan.v4.secret';
  const TIMEOUT_MS = 90000;
  const webview = window.chrome && window.chrome.webview;
  const isDesktop = !!(webview && webview.hostObjects);

  /* API keys are kept per provider, so switching provider does not lose a key.
     The first v4 build stored one bare key; it is read as the key of the provider in use then. */
  function readKeys(raw, fallbackProvider) {
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object') return value;
    } catch { /* a bare key, not JSON */ }
    return { [fallbackProvider]: raw };
  }

  async function request(url, options) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { ...options, signal: control.signal });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? '请求超时，请重试。' : '无法连接这个服务。请检查接口地址和网络；有些服务商不允许从浏览器直接访问。');
    } finally {
      clearTimeout(timer);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(P.explain(response.status, body));
    if (!body) throw new Error('模型服务返回的内容不是 JSON。');
    return body;
  }

  /* ---------- browser ---------- */
  const browser = {
    name: 'browser',
    canSeeImages: true,
    loadState: () => localStorage.getItem(STATE_KEY) || '',
    saveState: (json) => localStorage.setItem(STATE_KEY, json),
    loadKey(provider, legacyProvider) {
      return readKeys(localStorage.getItem(SECRET_KEY), legacyProvider || provider)[provider] || '';
    },
    saveKey(provider, value, legacyProvider) {
      const keys = readKeys(localStorage.getItem(SECRET_KEY), legacyProvider || provider);
      if (value) keys[provider] = value; else delete keys[provider];
      localStorage.setItem(SECRET_KEY, JSON.stringify(keys));
    },
    /* A web page cannot open files by path. The Windows shell provides this; here the user drags files in. */
    readPath: async () => { throw new Error('浏览器预览版不能按路径读取本地文件。请用户把文件拖进聊天框。'); },
    listDir: async () => { throw new Error('浏览器预览版不能列出本地文件夹。请用户把文件拖进聊天框。'); },
    async listModels(agent, key) {
      const call = P.modelsRequest(agent, key);
      return P.parseModels(await request(call.url, { headers: call.headers }));
    },
    /* `key` is passed when testing settings that are not saved yet. */
    async chat(agent, system, user, images, key) {
      const call = P.chatRequest(agent, key === undefined ? browser.loadKey(agent.provider) : key, system, user, images);
      return P.parseChat(agent, await request(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(call.body) }));
    },
  };

  /* ---------- Windows shell (same bridge contract as v3-desktop: Database host object + ai-request messages).
     The shell reads the model settings from the saved state and keeps the API key encrypted with DPAPI.
     Listing models and sending images need shell support that does not exist yet. ---------- */
  function desktopPlatform() {
    const db = webview.hostObjects.sync.database;
    const SHELL_KEY = 'tplan.v3'; // the only state key the existing shell accepts
    const pending = new Map();
    webview.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || (m.kind !== 'ai-response' && m.kind !== 'fs-response')) return;
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.text);
    });
    /* Sends a request to the shell and waits for the reply with the same id. */
    function ask(message, timeoutMs, cancelKind) {
      const id = 'rq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (cancelKind) webview.postMessage({ kind: cancelKind, id });
          reject(new Error('请求超时，请重试。'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        webview.postMessage({ ...message, id });
      });
    }
    return {
      name: 'desktop',
      canSeeImages: false,
      loadState: () => db.Read(SHELL_KEY),
      saveState: (json) => db.Write(SHELL_KEY, json),
      loadKey: () => db.ReadSecret(),
      saveKey: (provider, value) => db.WriteSecret(value || ''),
      readPath: (path) => ask({ kind: 'fs-request', op: 'read', path }, 15000),
      listDir: (path) => ask({ kind: 'fs-request', op: 'list', path }, 15000),
      listModels: async () => { throw new Error('桌面版暂时不能读取模型列表，请手动填写模型名称。'); },
      chat(agent, system, user, images) {
        if (images && images.length) return Promise.reject(new Error('桌面版暂时不能发送图片。'));
        return ask({ kind: 'ai-request', system, user }, TIMEOUT_MS, 'ai-cancel');
      },
    };
  }

  window.TPlanPlatform = isDesktop ? desktopPlatform() : browser;
})();
