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
    callAI(request.config, request.prompt, 'answer')
      .then(response => sendResponse({ success: true, data: response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'analyzeHTML') {
    callAI(request.config, request.prompt, 'analyze')
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
});

async function callAI(config, prompt, mode) {
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

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompts[mode] || systemPrompts.answer },
        { role: 'user', content: prompt },
      ],
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
