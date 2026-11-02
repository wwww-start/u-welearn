// ==UserScript==
// @name         U校园当前页内容采集器
// @namespace    local.unipus.courseware-collector
// @version      2.0.0
// @description  手动采集当前活动页实际渲染的正文、题目、选项、下拉空位和媒体信息；不遍历、不答题。
// @match        https://ucontent.unipus.cn/_explorationpc_default/pc.html*
// @match        https://ipub.unipus.cn/*
// @match        https://ipublish.unipus.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  const KIND = 'unipus-current-page-capture-v2';
  const DB_NAME = 'unipus-courseware-collector';
  const isTop = window === window.top;
  const clean = (value, limit = 120000) => String(value || '')
    .replace(/\r/g, '').replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n').trim().slice(0, limit);
  const trusted = origin => /^https:\/\/(?:ucontent|ipub|ipublish)\.unipus\.cn$/i.test(origin);

  function visible(el) {
    if (!el?.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function activeLabel(selector) {
    const el = document.querySelector(selector);
    return clean(el?.getAttribute('title') || el?.innerText || '', 120);
  }

  function pageRoot() {
    return document.querySelector('.pc-content-container') ||
      document.querySelector('.pc-main-container') ||
      document.querySelector('main,[role="main"],.pc-courseware-content') ||
      document.body;
  }

  function collectDropdowns(root) {
    return [...root.querySelectorAll('.fe-scoop[data-scoop-index]')].filter(visible)
      .map((scoop, index) => {
        const row = scoop.closest('tr');
        const cell = scoop.closest('td') || row;
        const stem = cell?.cloneNode(true);
        stem?.querySelectorAll('.fe-scoop,ol,ul,img,video').forEach(el => el.remove());
        const options = [...(row?.querySelectorAll('ol > li') || [])]
          .map((el, i) => ({ label: String.fromCharCode(65 + i), text: clean(el.innerText, 1000) }));
        return {
          index: Number(scoop.getAttribute('data-scoop-index') ?? index),
          stem: clean(stem?.textContent || '', 2000),
          options,
          selected: clean(scoop.querySelector('.user-answer-text')?.textContent || '', 100)
        };
      });
  }

  function snapshot() {
    const root = pageRoot();
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,#unipus-courseware-collector').forEach(el => el.remove());
    const controls = [...root.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
      .filter(visible).slice(0, 250).map(el => ({
        kind: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        placeholder: el.getAttribute('placeholder') || '',
        text: clean(el.innerText || '', 1000),
        value: /^(password|hidden)$/i.test(el.getAttribute('type') || '') ? '' : clean(el.value || '', 2000)
      }));
    const blocks = [...root.querySelectorAll('.question-common-abs-choice,.question-common-abs-reply,.question-abs-material')]
      .filter(visible).slice(0, 100).map(el => ({
        kind: clean(el.className, 200), text: clean(el.innerText || '', 6000)
      }));
    const media = [...root.querySelectorAll('audio,video,source,img')].filter(visible)
      .slice(0, 120).map(el => ({
        type: el.tagName.toLowerCase(),
        src: el.currentSrc || el.src || el.getAttribute('src') || '',
        poster: el.getAttribute('poster') || '', alt: el.alt || ''
      }));
    return {
      url: location.href,
      title: document.title,
      stage: activeLabel('.pc-header-sections-row .pc-header-section-activity,.pc-header-stage-activity'),
      tab: activeLabel('.pc-header-tasks-row .pc-header-task-activity'),
      frame: isTop ? 'top' : 'child',
      capturedAt: new Date().toISOString(),
      text: clean(root.innerText || ''),
      html: clone.outerHTML.slice(0, 300000),
      dropdowns: collectDropdowns(root),
      controls, blocks, media
    };
  }

  if (!isTop) {
    addEventListener('message', event => {
      if (event.source !== window.top || !trusted(event.origin) || event.data?.kind !== KIND || event.data.command !== 'capture') return;
      window.top.postMessage({ kind: KIND, requestId: event.data.requestId, page: snapshot() }, event.origin);
    });
    return;
  }

  let directory = null;
  let panel;
  let lastCapture = null;
  const status = text => { if (panel) panel.querySelector('[data-status]').textContent = text; };

  function directoryDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('settings');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function saveDirectory(handle) {
    const db = await directoryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(handle, 'directory');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function restoreDirectory() {
    try {
      const db = await directoryDB();
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readonly');
        const req = tx.objectStore('settings').get('directory');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
        directory = handle;
        status(`保存目录：${handle.name}`);
      }
    } catch (_) {}
  }

  function fileName(result) {
    const label = clean(result.pages[0]?.tab || result.pages[0]?.title || 'current-page', 60)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
    let hash = 2166136261;
    for (const char of result.pages[0]?.url || '') hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${label}-${(hash >>> 0).toString(16).padStart(8, '0')}.json`;
  }

  async function captureCurrent() {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pages = [snapshot()];
    const onMessage = event => {
      if (trusted(event.origin) && event.data?.kind === KIND && event.data.requestId === requestId && event.data.page?.url) {
        pages.push(event.data.page);
      }
    };
    addEventListener('message', onMessage);
    document.querySelectorAll('iframe').forEach(frame => {
      try { frame.contentWindow?.postMessage({ kind: KIND, command: 'capture', requestId }, '*'); } catch (_) {}
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    removeEventListener('message', onMessage);
    lastCapture = { capturedAt: new Date().toISOString(), pages };
    if (directory) {
      const file = await directory.getFileHandle(fileName(lastCapture), { create: true });
      const writer = await file.createWritable();
      await writer.write(JSON.stringify(lastCapture, null, 2));
      await writer.close();
      status(`已保存当前页：${fileName(lastCapture)}（${pages.length} 个页面框架）`);
    } else {
      status(`已采集当前页（${pages.length} 个页面框架）；点击“下载当前页”保存。`);
    }
    return lastCapture;
  }

  panel = document.createElement('div');
  panel.id = 'unipus-courseware-collector';
  panel.style.cssText = 'position:fixed;right:15px;bottom:15px;z-index:2147483647;background:#fff;color:#111;border:1px solid #777;border-radius:9px;padding:10px;box-shadow:0 3px 15px #0004;font:13px system-ui;max-width:340px';
  panel.innerHTML = '<b>当前页采集</b><br><button data-folder>选择保存目录</button> <button data-capture>采集当前页</button> <button data-export>下载当前页</button><div data-status style="margin-top:5px;overflow-wrap:anywhere">只采集当前活动页，不遍历目录。</div>';
  document.body.appendChild(panel);
  restoreDirectory();
  panel.querySelector('[data-folder]').onclick = async () => {
    if (!window.showDirectoryPicker) { status('当前浏览器不支持选择文件夹，请使用 Chrome 或 Edge。'); return; }
    try {
      directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      await saveDirectory(directory);
      status(`保存目录：${directory.name}；点击“采集当前页”写入。`);
    } catch (error) { if (error.name !== 'AbortError') status('选择目录失败：' + error.message); }
  };
  panel.querySelector('[data-capture]').onclick = async () => {
    try { await captureCurrent(); } catch (error) { status('采集失败：' + error.message); }
  };
  panel.querySelector('[data-export]').onclick = async () => {
    try {
      const result = await captureCurrent();
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName(result);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status(`已下载当前页：${link.download}`);
    } catch (error) { status('下载失败：' + error.message); }
  };
})();
