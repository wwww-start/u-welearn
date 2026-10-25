// Background Service Worker
// Handles API calls to avoid CORS issues

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if(request.action==='welearnFrameCommand'){
    relayWelearnFrame(request,sender).then(data=>sendResponse({success:true,data})).catch(error=>sendResponse({success:false,error:error.message}));
    return true;
  }
  if(request.action==='fetchWelearnData'){
    try{
      const u=new URL(request.url);
      if(u.protocol!=='https:'||u.hostname!=='centercourseware.sflep.com')throw new Error('WE Learn data host required');
      fetch(u.href).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(data=>sendResponse({success:true,data})).catch(e=>sendResponse({success:false,error:e.message}));
    }catch(e){sendResponse({success:false,error:e.message});}
    return true;
  }
  if (request.action === 'callAI') {
    callAI(request.config, request.prompt, 'answer', request.imageDataUrl)
      .then(response => sendResponse({ success: true, data: response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'analyzeHTML') {
    callAI(request.config, request.prompt, 'analyze', request.imageDataUrl)
      .then(response => sendResponse({ success: true, data: response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'fetchUnipusCrossOrigin') {
    fetchUnipusAPI(request.url, request.options)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'trackStats') {
    sendStats(request.event).then(() => sendResponse({ success: true }));
    return true;
  }

  // ---- 学习通支持 ----

  // 抓图并转 dataURL（content script 有 CORS 限制，图片只能由 background 取）
  if (request.action === 'fetchImageAsDataUrl') {
    fetchImageAsDataUrl(request.url)
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // 截取可见区域
  if (request.action === 'captureVisibleTab') {
    const windowId = sender.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // 供 content script 取当前启用模型
  if (request.action === 'getActiveModelConfig') {
    getActiveModelConfig()
      .then(config => sendResponse({ success: true, config }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

async function fetchImageAsDataUrl(url) {
  if (!url || !/^https?:/i.test(url)) throw new Error('仅支持 http(s) 图片地址');
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('图片请求失败 HTTP ' + resp.status);
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  // ArrayBuffer → base64（Service Worker 无 FileReader）
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);
  const mime = blob.type || 'image/png';
  return 'data:' + mime + ';base64,' + b64;
}

// 与 popup.js 的 PRESET_MODELS / BUILTIN_MODEL 保持一致
const FALLBACK_MODELS = {
  'builtin-glm4flash': {
    id: 'builtin-glm4flash',
    name: 'GLM-4-Flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
  },
  'builtin-deepseek-v41-flash': {
    id: 'builtin-deepseek-v41-flash',
    name: 'DeepSeek V4.1 Flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
  },
};

async function getActiveModelConfig() {
  const data = await chrome.storage.sync.get(['aiModels', 'activeModelId']);
  const activeId = data.activeModelId || 'builtin-glm4flash';
  const saved = (data.aiModels || []).find(m => m.id === activeId);
  if (saved) return saved;
  return FALLBACK_MODELS[activeId] || FALLBACK_MODELS['builtin-glm4flash'];
}

async function callAI(config, prompt, mode, imageDataUrl) {
  const { baseUrl, model } = config || {};
  const apiKey = String(config?.apiKey || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error('API 密钥为空或包含空白，请在设置中重新粘贴完整密钥');
  if (!baseUrl || !model) throw new Error('请补全 API 地址和模型名称');

  let url = baseUrl.trim().replace(/\/$/, '');
  if (!url.endsWith('/chat/completions')) {
    url += '/chat/completions';
  }

  const systemPrompts = {
    answer: '你是一个专业的答题助手。给出准确答案，只返回JSON。',
    analyze: '你是一个专业的网页结构分析助手。识别题目结构，只返回JSON，不要返回答案。',
  };

  // 有图片时用多模态 content 数组；否则用纯文本
  const userContent = imageDataUrl
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : prompt;

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompts[mode] || systemPrompts.answer },
        { role: 'user', content: userContent },
      ],
      // 不设上限时默认值会把长答案截断，导致 JSON 不完整、解析失败
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('API请求失败 (401)：当前 API 地址拒绝了此密钥。请在扩展设置中检查地址与密钥是否配套，保存有效密钥后再试；重试和翻页不会修复认证。');
    const errorText = await response.text();
    throw new Error('API请求失败 (' + response.status + '): ' + errorText.substring(0, 200));
  }

  const data = await response.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('API返回格式错误');
  }

  return data.choices[0].message.content;
}

async function fetchUnipusAPI(url, options) {
  options = options || {};
  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || undefined,
  });
  if (!resp.ok) {
    throw new Error('Unipus API error: ' + resp.status);
  }
  return await resp.json();
}

async function sendStats(event) {
  try {
    await fetch('https://d.yikfun.de5.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: event }),
    });
  } catch (e) {
    // 静默失败
  }
}


async function relayWelearnFrame(request,sender) {
  if(!sender.tab?.id || !/^https:\/\/welearn\.sflep\.com\//.test(sender.url||''))throw new Error('WE Learn wrapper required');
  if(!['welearnProcess','welearnStop'].includes(request.message?.action))throw new Error('Unknown lesson command');
  const frames=await chrome.scripting.executeScript({
    target:{tabId:sender.tab.id,allFrames:true},func:()=>({host:location.hostname,url:location.href})
  });
  const target=frames.find(f=>f.result?.host==='centercourseware.sflep.com');
  if(!target)throw new Error('课件框架尚未加载');
  return await chrome.tabs.sendMessage(sender.tab.id,request.message,{frameId:target.frameId});
}
