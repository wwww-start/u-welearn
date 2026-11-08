// background.js 消息路径冒烟测试
// 用途：抓「语法合法但引用错误」的问题（例如 callAI 里误用 request 导致 ReferenceError）
// 用法：node tests/background-smoke.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'background.js');
const src = fs.readFileSync(SRC, 'utf8');

const listeners = [];
const calls = [];

const ctx = {
  console, setTimeout, clearTimeout, AbortSignal, btoa, URLSearchParams,
  TextEncoder, Uint8Array, ArrayBuffer, JSON, Math, Number, String, Promise, Error,
  fetch: async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"answer":"B","confidence":0.8}' }, finish_reason: 'stop' }] }),
      text: async () => '',
    };
  },
  chrome: {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} },
      lastError: undefined,
    },
    storage: { sync: { get: async () => ({ aiModels: [], activeModelId: 'x' }) } },
    sidePanel: { setPanelBehavior: () => {} },
    action: { onClicked: { addListener: () => {} } },
    tabs: { captureVisibleTab: async () => 'data:image/png;base64,AAAA' },
    scripting: { executeScript: async () => [] },
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

if (!listeners.length) { console.log('FAIL 没有注册 onMessage 监听'); process.exit(1); }
const handler = listeners[0];

function send(req) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const ret = handler(req, { tab: { id: 1, windowId: 1 } }, finish);
      if (ret !== true && !done) setTimeout(() => finish({ noResponse: true }), 500);
    } catch (e) {
      finish({ thrown: String(e && e.message) });
    }
    setTimeout(() => finish({ timeout: true }), 8000);
  });
}

(async () => {
  const cfg = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-test-xxxx' };
  let fail = 0;

  const r1 = await send({ action: 'callAI', config: cfg, prompt: 'hello' });
  const t1 = calls.length ? calls[calls.length - 1].body.max_tokens : null;
  console.log('callAI 文本     : ' + JSON.stringify(r1).slice(0, 80) + '  max_tokens=' + t1);
  if (!r1 || !r1.success || t1 !== 8192) { fail++; console.log('  FAIL 期望 max_tokens=8192'); }

  const r2 = await send({ action: 'callAI', config: cfg, prompt: 'img', imageDataUrl: 'data:image/png;base64,AAAA', maxTokens: 4096 });
  const t2 = calls.length ? calls[calls.length - 1].body.max_tokens : null;
  console.log('callAI 图片+自定义: ' + JSON.stringify(r2).slice(0, 60) + '  max_tokens=' + t2);
  if (!r2 || !r2.success || t2 !== 4096) { fail++; console.log('  FAIL 期望 max_tokens=4096'); }

  const r3 = await send({ action: 'getActiveModelConfig' });
  console.log('getActiveModelConfig: ' + JSON.stringify(r3).slice(0, 80));
  if (!r3 || !r3.success) { fail++; console.log('  FAIL 期望 success=true'); }

  console.log(fail ? '\nFAIL ' + fail + ' 项' : '\nPASS 全部通过');
  process.exit(fail ? 1 : 0);
})();
