// DOM Elements
const statusBadge = document.getElementById("statusBadge");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const questionCount = document.getElementById("questionCount");
const answeredCount = document.getElementById("answeredCount");

const startBtn = document.getElementById("startBtn");
const startBtnText = document.getElementById("startBtnText");
const autoContinueToggle = document.getElementById("autoContinue");
const skipToggle=document.getElementById("skipUnfinished");
const skippedCount=document.getElementById("skippedCount");
skipToggle.addEventListener("change",()=>chrome.storage.sync.set({skipUnfinished:skipToggle.checked}));
autoContinueToggle.addEventListener("change",()=>chrome.storage.sync.set({autoContinue:autoContinueToggle.checked}));

// Settings Modal Elements
const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const closeSettingsBackdrop = document.getElementById("closeSettingsBackdrop");
const modelList = document.getElementById("modelList");
const addModelBtn = document.getElementById("addModelBtn");

// Edit Model Modal Elements
const editModelModal = document.getElementById("editModelModal");
const closeEditBtn = document.getElementById("closeEditBtn");
const closeEditBackdrop = document.getElementById("closeEditBackdrop");
const editModalTitle = document.getElementById("editModalTitle");
const editNameInput = document.getElementById("editName");
const editBaseUrlInput = document.getElementById("editBaseUrl");
const editApiKeyInput = document.getElementById("editApiKey");
const editModelInput = document.getElementById("editModel");
const editStatus = document.getElementById("editStatus");
const saveModelBtn = document.getElementById("saveModelBtn");
const toggleEditApiKeyBtn = document.getElementById("toggleEditApiKey");

let editingModelId = null;

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");

// State
let isRunning = false;
let hasScanned = false;

// Built-in default model — GLM-4-Flash
// API Key 需用户在设置中自行填入
const BUILTIN_MODEL = {
  id: "builtin-glm4flash",
  name: "GLM-4-Flash",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "",
  model: "glm-4-flash",
  builtin: false,
};

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  await initModels();
  const prefs=await chrome.storage.sync.get(["skipUnfinished","autoContinue"]);
  skipToggle.checked=!!prefs.skipUnfinished;
  autoContinueToggle.checked=prefs.autoContinue!==false;

  // Check active session
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, { action: "getStatus" }, (response) => {
      if (chrome.runtime.lastError) return;

      if (response) {
        renderStats(response);
        answeredCount.textContent = response.answeredCount || 0;

        if (response.isRunning) {
          setRunningState(true);
          addLog("info", "检测到正在运行的任务");
        } else if (response.questionCount > 0) {
          hasScanned = true;
          addLog("info", "检测到已扫描题目，可以开始");
        }
      }
    });
  }
});

// --- Modal Logic ---
function openModal() {
  settingsModal.classList.add("open");
  renderModelList();
}

function closeModal() {
  settingsModal.classList.remove("open");
}

function openEditModal(modelId = null) {
  editingModelId = modelId;
  editModelModal.classList.add("open");

  if (modelId) {
    editModalTitle.textContent = "编辑模型";
    loadModelForEdit(modelId);
  } else {
    editModalTitle.textContent = "添加模型";
    editNameInput.value = "";
    editBaseUrlInput.value = "https://api.openai.com/v1";
    editApiKeyInput.value = "";
    editModelInput.value = "";
  }
}

function closeEditModal() {
  editModelModal.classList.remove("open");
  editingModelId = null;
}

openSettingsBtn.addEventListener("click", openModal);
closeSettingsBtn.addEventListener("click", closeModal);
closeSettingsBackdrop.addEventListener("click", closeModal);
addModelBtn.addEventListener("click", () => openEditModal());
closeEditBtn.addEventListener("click", closeEditModal);
closeEditBackdrop.addEventListener("click", closeEditModal);

// --- Template Management ---
const openTemplatesBtn = document.getElementById("openTemplatesBtn");
openTemplatesBtn.addEventListener("click", () => {
  window.location.href = "template-manager.html";
});

// --- Model Management Logic ---
toggleEditApiKeyBtn.addEventListener("click", () => {
  const type = editApiKeyInput.type === "password" ? "text" : "password";
  editApiKeyInput.type = type;
  toggleEditApiKeyBtn.style.opacity = type === "text" ? "1" : "0.6";
});

async function initModels() {
  const data = await chrome.storage.sync.get([
    "aiModels",
    "activeModelId",
    "baseUrl",
    "apiKey",
    "model",
  ]);

  // Migrate old config to new structure
  if (!data.aiModels && data.apiKey) {
    const customModel = {
      id: "custom-" + Date.now(),
      name: "自定义模型",
      baseUrl: data.baseUrl || "https://api.openai.com/v1",
      apiKey: data.apiKey,
      model: data.model || "gpt-4o-mini",
      builtin: false,
    };
    await chrome.storage.sync.set({
      aiModels: [customModel],
      activeModelId: customModel.id,
    });
  } else if (!data.aiModels) {
    // First time, set builtin as active
    await chrome.storage.sync.set({
      aiModels: [],
      activeModelId: BUILTIN_MODEL.id,
    });
  }
}

async function getAllModels() {
  const data = await chrome.storage.sync.get(["aiModels"]);
  const models = new Map([[BUILTIN_MODEL.id, { ...BUILTIN_MODEL }]]);
  for (const saved of data.aiModels || []) models.set(saved.id, saved);
  return [...models.values()];
}

async function getActiveModel() {
  const data = await chrome.storage.sync.get(["activeModelId"]);
  const models = await getAllModels();
  const activeId = data.activeModelId || BUILTIN_MODEL.id;
  return models.find((m) => m.id === activeId) || BUILTIN_MODEL;
}

async function renderModelList() {
  const models = await getAllModels();
  const data = await chrome.storage.sync.get(["activeModelId"]);
  const activeId = data.activeModelId || BUILTIN_MODEL.id;

  modelList.innerHTML = models
    .map(
      (model) => `
    <div class="model-item ${
      model.id === activeId ? "active" : ""
    }" data-model-id="${model.id}">
      <input type="radio" name="activeModel" class="model-radio" value="${
        model.id
      }" ${model.id === activeId ? "checked" : ""}>
      <div class="model-info">
        <div class="model-name">
          ${model.name}
          ${model.builtin ? '<span class="model-badge">内置</span>' : ""}
        </div>
        <div class="model-meta">${model.model}</div>
      </div>
      <div class="model-actions">
        ${
          !model.builtin
            ? `
          <button class="icon-btn edit-model-btn" data-model-id="${model.id}">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </button>
          <button class="icon-btn delete-model-btn" data-model-id="${model.id}">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        `
            : ""
        }
      </div>
    </div>
  `
    )
    .join("");

  // Add click event to entire model card
  document.querySelectorAll(".model-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      // Don't trigger if clicking on action buttons
      if (
        e.target.closest(".edit-model-btn") ||
        e.target.closest(".delete-model-btn")
      ) {
        return;
      }

      const modelId = item.dataset.modelId;
      const model = models.find((m) => m.id === modelId);

      await chrome.storage.sync.set({ activeModelId: modelId });
      addLog("success", `已使用${model.name}模型`);
      closeModal();
    });
  });

  // Add event listeners for radio buttons
  document.querySelectorAll(".model-radio").forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      e.stopPropagation();
      await chrome.storage.sync.set({ activeModelId: e.target.value });
      renderModelList();
    });
  });

  // Add event listeners for edit buttons
  document.querySelectorAll(".edit-model-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      openEditModal(modelId);
    });
  });

  // Add event listeners for delete buttons
  document.querySelectorAll(".delete-model-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      if (!confirm("确定要删除这个模型吗？")) return;

      const data = await chrome.storage.sync.get(["aiModels", "activeModelId"]);
      const models = (data.aiModels || []).filter((m) => m.id !== modelId);

      const updates = { aiModels: models };
      if (data.activeModelId === modelId) {
        updates.activeModelId = BUILTIN_MODEL.id;
      }

      await chrome.storage.sync.set(updates);
      renderModelList();
    });
  });
}

async function loadModelForEdit(modelId) {
  const models = await getAllModels();
  const model = models.find((m) => m.id === modelId);
  if (model) {
    editNameInput.value = model.name;
    editBaseUrlInput.value = model.baseUrl;
    editApiKeyInput.value = model.apiKey;
    editModelInput.value = model.model;
  }
}

saveModelBtn.addEventListener("click", async () => {
  const name = editNameInput.value.trim();
  const baseUrl = editBaseUrlInput.value.trim();
  const apiKey = editApiKeyInput.value.trim();
  const model = editModelInput.value.trim();

  if (!name || !baseUrl || !apiKey || !model) {
    showEditStatus("error", "请填写所有配置项");
    return;
  }

  saveModelBtn.disabled = true;
  saveModelBtn.textContent = "保存中...";

  const data = await chrome.storage.sync.get(["aiModels"]);
  const models = data.aiModels || [];
  const savedId = editingModelId || "custom-" + Date.now();

  if (editingModelId) {
    // Edit existing
    const index = models.findIndex((m) => m.id === editingModelId);
    if (index !== -1) {
      models[index] = { ...models[index], name, baseUrl, apiKey, model };
    } else {
      // 默认 GLM 配置只是预设；第一次编辑也必须真正写入存储。
      models.push({ id: savedId, name, baseUrl, apiKey, model, builtin: false });
    }
  } else {
    // Add new
    models.push({
      id: savedId,
      name,
      baseUrl,
      apiKey,
      model,
      builtin: false,
    });
  }

  await chrome.storage.sync.set({ aiModels: models, activeModelId: savedId });

  setTimeout(() => {
    saveModelBtn.disabled = false;
    saveModelBtn.textContent = "保存并使用";
    showEditStatus("success", "已保存并启用此配置");
    setTimeout(() => {
      closeEditModal();
      renderModelList();
    }, 500);
  }, 300);
});

document.getElementById('testModelBtn')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('modelTestStatus');
  button.disabled = true;
  try {
    const model = await getActiveModel();
    const endpoint = new URL(model.baseUrl);
    status.textContent = `正在测试已保存的 ${model.name} / ${model.model} / ${endpoint.host}（会发送一次简短 AI 请求）`;
    if (!model.apiKey?.trim()) throw new Error('当前启用配置的密钥为空，请编辑后点击“保存并使用”');
    const response = await chrome.runtime.sendMessage({action:'callAI',config:model,prompt:'Reply with OK only.'});
    if (!response?.success) throw new Error(response?.error || '测试请求没有返回结果');
    status.textContent = `连接成功：${model.name} / ${model.model} / ${endpoint.host}`;
  } catch (error) {
    status.textContent = `测试失败：${error.message}`;
  } finally { button.disabled = false; }
});

function showEditStatus(type, message) {
  editStatus.textContent = message;
  editStatus.className = `config-status ${type}`;
  setTimeout(() => {
    editStatus.textContent = "";
    editStatus.className = "config-status";
  }, 3000);
}

// --- Action Logic ---

// 确保 content script 已注入到目标页面
async function ensureContentScriptInjected(tabId) {
  try {
    // 先尝试发送一个测试消息
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "getStatus" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script 未加载，尝试注入
          console.log("[popup] Content script 未加载，尝试注入...");
          injectContentScript(tabId)
            .then(resolve)
            .catch(() => resolve(false));
        } else {
          // 已加载
          resolve(true);
        }
      });
    });
  } catch (e) {
    console.error("[popup] 检查 content script 失败:", e);
    return false;
  }
}

// 程序化注入 content script
async function injectContentScript(tabId) {
  try {
    // 检查是否是可以注入的页面
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      console.log("[popup] 无法在系统页面注入脚本");
      return false;
    }

    // 注入 CSS
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames:true },
      files: ["content.css"],
    });

    // 按顺序注入 JS 模块
    await chrome.scripting.executeScript({
      target: { tabId, allFrames:true },
      files: [
        "modules/site-matcher.js",
        "modules/template-manager.js",
        "modules/bank.js",
        "modules/unipus-page-model.js",
        "modules/scanner-enhanced.js",
        "modules/unipus-api.js",
        "modules/welearn-api.js",
        "modules/flow-policy.js",
        "modules/welearn-controller.js",
        "content.js",
      ],
    });

    console.log("[popup] Content script 注入成功");
    // 等待脚本初始化
    await new Promise((resolve) => setTimeout(resolve, 200));
    return true;
  } catch (e) {
    console.error("[popup] 注入 content script 失败:", e);
    return false;
  }
}

// 自动答题（一键：扫描 + 答题）
startBtn.addEventListener("click", async () => {
  if (isRunning) {
    // 暂停
    setRunningState(false);
    addLog("warning", "已暂停答题");
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "stop" });
    }
    return;
  }

  const activeModel = await getActiveModel();
  const config = {
    baseUrl: activeModel.baseUrl,
    apiKey: activeModel.apiKey,
    model: activeModel.model,
  };
  let endpointLabel = '地址格式待检查';
  try { endpointLabel = new URL(config.baseUrl).host; } catch (_) {}
  addLog('info', `当前 AI 配置：${activeModel.name} / ${config.model} / ${endpointLabel}；密钥${config.apiKey?.trim() ? '已保存' : '为空'}。平台返回答案时不会调用 AI。`);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    addLog("error", "无法获取当前标签页");
    return;
  }

  const tab = tabs[0];

  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("about:")
  ) {
    addLog("error", "请切换到有题目的网页");
    return;
  }

  const injected = await ensureContentScriptInjected(tab.id);
  if (!injected) {
    addLog("error", "无法连接到页面，请刷新页面后重试");
    return;
  }

  setRunningState(true);
  addLog("info", "🚀 开始自动答题");
  chrome.tabs.sendMessage(
    tab.id,
    { action: "start", config, autoContinue: autoContinueToggle.checked, skipUnfinished:skipToggle.checked },
    (response) => {
      if (chrome.runtime.lastError) {
        setRunningState(false);
        addLog("error", "连接中断，请刷新页面后重试");
      }
    }
  );
});

function setRunningState(active) {
  isRunning = active;
  if (active) {
    startBtnText.textContent = "暂停答题";
    startBtn.classList.remove("btn-primary");
    startBtn.classList.add("btn-warning");
    updateStatus("running", "答题中...");
  } else {
    startBtnText.textContent = "自动答题";
    startBtn.classList.remove("btn-warning");
    startBtn.classList.add("btn-primary");
    updateStatus("ready", "就绪");
  }
}

// --- Helpers ---

function updateStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const logItem = document.createElement("div");
  logItem.className = `log-item log-${type}`;
  const stamp=document.createElement('span');stamp.className='log-time';stamp.textContent=time;
  const msg=document.createElement('span');msg.className='log-msg';msg.textContent=String(message);msg.style.whiteSpace='pre-wrap';
  logItem.append(stamp,msg);
  logContent.appendChild(logItem);
  logContent.scrollTop = logContent.scrollHeight;
}

clearLogBtn.addEventListener("click", () => {
  logContent.innerHTML = "";
  addLog("info", "日志已清空");
});

function renderStats(message) {
  questionCount.textContent = message.questionCount || 0;
  answeredCount.textContent = message.answeredCount || 0;
  const qlabel=questionCount.parentElement.querySelector('.stat-label');
  const alabel=answeredCount.parentElement.querySelector('.stat-label');
  if(qlabel)qlabel.textContent='题组 · '+(message.blankCount||0)+' 个空位';
  if(alabel)alabel.textContent='已填写 · '+(message.answeredBlankCount||0)+' 个空位';
  const submitted=document.getElementById('submittedSummary');
  if(submitted)submitted.textContent='已确认提交 '+(message.submittedCount||0)+' 组';
}
function addAnswerPreview(message) {
  const rows=Array.isArray(message.rows)?message.rows:[];
  if(!rows.length)return;
  const answerText=rows.map(r=>r.number+'. '+(r.label?r.label+' — ':'')+r.text).join('\n');
  addLog('success',message.source+'\n'+answerText+'\n'+(message.note||''));
  const item=logContent.lastElementChild;
  item.style.display='grid';item.style.gridTemplateColumns='40px minmax(0,1fr)';
  const copy=document.createElement('button');copy.type='button';copy.textContent='复制答案';
  copy.style.cssText='grid-column:2;justify-self:start;white-space:nowrap;font-size:12px;margin:6px 0;border-radius:10px;padding:4px 10px;cursor:pointer';
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(answerText);copy.textContent='已复制';}catch{addLog('warning','复制未成功，请手动选中答案');}});
  item.append(copy);
}

// Message Listener
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "answerPreview":
      addAnswerPreview(message);
      break;
    case "log":
      addLog(message.level, message.text);
      break;
    case "updateStats":
      renderStats(message);
      skippedCount.textContent=message.skippedCount||0;
      break;
    case "complete":
      setRunningState(false);
      updateStatus("ready", message.success ? (message.skippedCount ? "遍历结束，有跳过项" : "完成") : "已停止");
      addLog(message.success ? "success" : "warning",
        `${message.success ? (message.skippedCount ? "遍历结束（有未完成页）" : "🎉 自动流程完成") : "自动流程已停在当前页"} (本页${message.answeredCount}题)`);
      break;
    case "error":
      setRunningState(false);
      updateStatus("error", "错误");
      addLog("error", message.text);
      break;
  }
});
