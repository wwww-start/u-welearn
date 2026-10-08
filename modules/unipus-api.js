// Current-session answer adapter. No embedded signing/decryption secrets.
(function () {
  "use strict";
  function extractPageInfo() {
    const result = {
      courseInstanceId: null,
      taskId: null,
      openId: null,
    };

    // 1. 从 URL path + hash 提取 courseInstanceId 和 taskId
    const url = window.location.href;
    const hash = window.location.hash.replace(/^#\/?/, ""); // 去掉 #/
    const pathParts = window.location.pathname.split("/");
    const hashParts = hash ? hash.split("/") : [];

    // 合并 path 和 hash 的所有分段（hash 在后，优先级更高）
    const allParts = [...pathParts, ...hashParts];

    for (const part of allParts) {
      if (part.startsWith("course-v2:")) {
        result.courseInstanceId = part;
        break;
      }
    }

    // 2. 从所有分段提取 taskId（取最后一个 hex nodeId，即最具体的节点）
    const hexIds = allParts.filter(
      p => /^[a-f0-9]{12,40}$/i.test(p) && p !== result.courseInstanceId
    );
    if (hexIds.length > 0) {
      result.taskId = hexIds[hexIds.length - 1];
    }

    // 也检查 query 参数（含 hash 中的 query）
    const searchParams = new URLSearchParams(window.location.search);
    // 如果 hash 中包含 query string，也解析
    const hashQueryIdx = hash.indexOf("?");
    const hashParams = hashQueryIdx >= 0
      ? new URLSearchParams(hash.substring(hashQueryIdx + 1))
      : null;

    if (!result.taskId) {
      result.taskId =
        searchParams.get("taskId") ||
        searchParams.get("nodeId") ||
        searchParams.get("task_id") ||
        hashParams?.get("taskId") ||
        hashParams?.get("nodeId");
    }
    if (!result.courseInstanceId) {
      result.courseInstanceId =
        searchParams.get("courseInstanceId") ||
        searchParams.get("courseId") ||
        searchParams.get("instanceId") ||
        hashParams?.get("courseInstanceId") ||
        hashParams?.get("courseId");
    }

    // 3. 从页面全局状态提取 courseInstanceId / taskId
    if (!result.courseInstanceId || !result.taskId) {
      try {
        const globals = [
          window.__INITIAL_STATE__,
          window.__NUXT__,
          window.__NEXT_DATA__,
          window.__APP_STATE__,
          window.store,
        ];
        for (const g of globals) {
          if (!g) continue;
          const s = typeof g === "string" ? g : JSON.stringify(g);
          if (!result.courseInstanceId) {
            const m = s.match(/(?:courseInstanceId|course_instance_id|instanceId)\s*[:=]\s*"([^"]+)"/i);
            if (m) result.courseInstanceId = m[1];
          }
          if (!result.taskId) {
            const m = s.match(/(?:taskId|task_id|nodeId|node_id)\s*[:=]\s*"([^"]+)"/i);
            if (m) result.taskId = m[1];
          }
          if (result.courseInstanceId && result.taskId) break;
        }
      } catch (_) {}
    }

    // 4. 从 DOM data 属性提取
    if (!result.courseInstanceId || !result.taskId) {
      const taskContainer = document.querySelector(
        "[data-course-id], [data-instance-id], [data-task-id], [data-node-id]"
      );
      if (taskContainer) {
        result.courseInstanceId =
          result.courseInstanceId ||
          taskContainer.dataset.courseId ||
          taskContainer.dataset.instanceId ||
          taskContainer.dataset.courseInstanceId;
        result.taskId =
          result.taskId ||
          taskContainer.dataset.taskId ||
          taskContainer.dataset.nodeId;
      }
    }

    return result;
  }
  function parseAnswers(decryptedJson) {
    let arr;
    try {
      arr = JSON.parse(decryptedJson);
    } catch (e) {
      console.error("[unipus-api] 解析答案 JSON 失败:", e);
      return [];
    }
    if (!Array.isArray(arr)) {
      console.error("[unipus-api] 答案数据不是数组");
      return [];
    }

    const flat = [];
    for (const item of arr) {
      let hasAnswerChildren = false;
      if (item.answer) {
        try {
          const answerContent = JSON.parse(item.answer);
          for (const child of answerContent.children || []) {
            if (!Array.isArray(child.answers) || child.answers.length === 0) continue;
            // 每个 child 是一道小题；child.answers 内可能是多选的多个选项。
            flat.push({ answers: child.answers.map(String), id: item.id || 0 });
            hasAnswerChildren = true;
          }
        } catch (_) {}
      }
      // 仅在没有标准 answer 时使用 analysis，避免把解释误计为下一题答案。
      if (!hasAnswerChildren && item.analysis) {
        try {
          const analysis = JSON.parse(item.analysis);
          for (const child of analysis.children || []) {
            if (child.analysis) flat.push({ answers: [String(child.analysis)], id: item.id || 0 });
          }
          if ((!analysis.children || analysis.children.length === 0) && analysis.analysis) {
            flat.push({ answers: [String(analysis.analysis)], id: item.id || 0 });
          }
        } catch (_) {}
      }
    }
    return flat;
  }


  async function getAnswersForTask(courseInstanceId, taskId) {
    if (!courseInstanceId || !taskId) return null;
    const response = await fetch('/course/api/v3/answer/' +
      encodeURIComponent(courseInstanceId) + '/' + encodeURIComponent(taskId) + '/default',
      { method: 'GET', credentials: 'same-origin' });
    if (!response.ok) return null;
    const body = await response.json();
    if (body.code !== 0 || !body.data) return null;
    // Only accept readable content returned under the existing platform session.
    // Encrypted/unavailable answers fall back to the configured AI flow.
    if (typeof body.data === 'string' && body.data.startsWith('unipus.')) return null;
    return parseAnswers(typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
  }
  window.unipusAPI = { extractPageInfo, parseAnswers, getAnswersForTask };
})();
