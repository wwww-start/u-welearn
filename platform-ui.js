// UI visibility only: no answer, video or submission messages are sent.
(function () {
  'use strict';
  function supportsCourseControls(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'unipus.cn' || host.endsWith('.unipus.cn') ||
        host === 'welearn.sflep.com' || host === 'centercourseware.sflep.com';
    } catch (_) { return false; }
  }
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    document.body.dataset.courseControls = 'hidden';
    try {
      const tabs = await chrome.tabs.query({active:true,currentWindow:true});
      if (current !== revision) return;
      document.body.dataset.courseControls = supportsCourseControls(tabs[0]?.url) ? 'visible' : 'hidden';
    } catch (_) { /* Leave controls hidden for unknown or restricted pages. */ }
  }
  chrome.tabs.onActivated?.addListener(refresh);
  chrome.tabs.onUpdated?.addListener((_id, change, tab) => {
    if (tab.active && (change.url || change.status === 'complete')) refresh();
  });
  window.addEventListener('focus', refresh);
  refresh();
})();
