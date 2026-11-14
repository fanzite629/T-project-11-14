/* Model providers: presets, and the HTTP request shapes for listing models and chatting.
   Pure data and functions, so the shapes can be tested without a network. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TPlanProviders = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /* `kind` is the wire protocol. Every preset's address can still be edited in Settings. */
  const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com' },
    { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
    { id: 'anthropic', name: 'Anthropic（Claude）', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { id: 'doubao', name: '豆包（火山方舟）', kind: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', note: '如果读不到模型列表，请手动填写方舟控制台里的模型 ID 或接入点 ID。' },
    { id: 'kimi', name: 'Kimi（Moonshot）', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', note: '国际版账号请把接口地址改成 https://api.moonshot.ai/v1。' },
    { id: 'custom', name: '其他（OpenAI 兼容接口、本机模型）', kind: 'openai', baseUrl: '' },
  ];
  const find = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[PROVIDERS.length - 1];
  const trimUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

  /* Settings saved by the first v4 build only knew "openai" and "anthropic". Map them onto presets. */
  function migrate(agent) {
    const a = { provider: 'deepseek', baseUrl: '', modelId: '', models: [], vision: null, ...agent };
    if (!PROVIDERS.some((p) => p.id === a.provider) || (a.provider === 'openai' && a.baseUrl && trimUrl(a.baseUrl) !== find('openai').baseUrl)) {
      const match = PROVIDERS.find((p) => p.baseUrl && trimUrl(a.baseUrl) === p.baseUrl);
      a.provider = match ? match.id : 'custom';
    }
    if (!a.baseUrl) a.baseUrl = find(a.provider).baseUrl;
    if (!Array.isArray(a.models)) a.models = [];
    return a;
  }

  function checkUrl(url) {
    if (!/^https:\/\/[^\s/]+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new Error('接口地址需要以 https:// 开头（本机模型可以用 http://localhost）');
  }
  function headers(kind, key) {
    if (kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    return key ? { authorization: 'Bearer ' + key } : {};
  }

  /* ---------- listing models ---------- */
  function modelsRequest(agent, key) {
    const { kind } = find(agent.provider);
    const base = trimUrl(agent.baseUrl);
    checkUrl(base);
    return { url: kind === 'anthropic' ? base + '/v1/models?limit=100' : base + '/models', headers: headers(kind, key) };
  }
  /* Both protocols answer { data: [{ id, ... }] }. Entries that are plainly not chat models are left out. */
  const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|realtime|transcri|audio|sora|rerank|babbage|davinci|image-|speech/i;
  function parseModels(json) {
    const list = json && Array.isArray(json.data) ? json.data : [];
    const ids = list.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter((id) => id && !NOT_CHAT.test(id));
    return [...new Set(ids)].sort();
  }

  /* ---------- chat ---------- */
  /* images: [{ mediaType: 'image/jpeg', data: '<base64>' }] */
  function chatRequest(agent, key, system, user, images = []) {
    const { kind } = find(agent.provider);
    const base = trimUrl(agent.baseUrl);
    checkUrl(base);
    if (!agent.modelId) throw new Error('请先选择模型');
    const head = { 'content-type': 'application/json', ...headers(kind, key) };
    if (kind === 'anthropic') {
      const content = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: user }];
      return { url: base + '/v1/messages', headers: head, body: { model: agent.modelId, max_tokens: 16000, system, messages: [{ role: 'user', content }] } };
    }
    const content = images.length
      ? [{ type: 'text', text: user }, ...images.map((im) => ({ type: 'image_url', image_url: { url: 'data:' + im.mediaType + ';base64,' + im.data } }))]
      : user;
    return { url: base + '/chat/completions', headers: head, body: { model: agent.modelId, messages: [{ role: 'system', content: system }, { role: 'user', content }] } };
  }
  function parseChat(agent, json) {
    if (find(agent.provider).kind === 'anthropic') {
      if (json.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求。');
      return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    const message = ((json.choices || [])[0] || {}).message || {};
    if (typeof message.content === 'string') return message.content;
    return Array.isArray(message.content) ? message.content.map((part) => part.text || '').join('') : '';
  }

  /* A short human explanation for a failed call. */
  function explain(status, body) {
    const detail = body && (body.error && (body.error.message || body.error) || body.message);
    const text = typeof detail === 'string' ? '：' + detail.slice(0, 200) : '';
    if (status === 401 || status === 403) return 'API 密钥无效或没有权限（HTTP ' + status + '）' + text;
    if (status === 404) return '找不到这个接口或模型（HTTP 404）' + text;
    if (status === 429) return '请求太频繁或额度不足（HTTP 429）' + text;
    return '模型服务返回 HTTP ' + status + text;
  }

  return { PROVIDERS, find, migrate, modelsRequest, parseModels, chatRequest, parseChat, explain };
});
