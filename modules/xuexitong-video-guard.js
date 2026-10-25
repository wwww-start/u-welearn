/**
 * 学习通视频播放器守卫（MAIN world, document_start）
 *
 * 作用：摘掉超星播放器用来检测「倍速 / 拖动进度」的三类事件监听，
 *      使播放器无法察觉异常，从而正常累计学习时长。
 *
 * 关键约束（缺一失效）：
 *   1. 必须 world: "MAIN"      —— 隔离世界改不到页面原型链
 *   2. 必须 run_at document_start —— 晚于播放器绑定即无效
 *   3. on* 属性也要废掉        —— 否则播放器用 el.onratechange = fn 绕过
 *
 * 实测依据：2026-10 版 Edge 156 + 超星 Edg/156 播放器页，
 *          执行后 addEventListener 被替换、onratechange/onseeked/onseeking 的 setter 被清空。
 */
(function () {
  "use strict";

  // 只在播放器页生效
  if (location.pathname !== "/ananas/modules/video/index.html") return;

  // 防止重复注入（同一 frame 内 manifest 与手动注入可能叠加）
  if (window.__CX_VIDEO_GUARD__) return;
  window.__CX_VIDEO_GUARD__ = true;

  // 可由扩展在运行时关闭（写 localStorage 后刷新或通过 postMessage）
  var ENABLED = true;
  window.__CX_VIDEO_GUARD_SET__ = function (on) {
    ENABLED = !!on;
  };

  var BLOCKED_EVENTS = ["ratechange", "seeked", "seeking"];

  try {
    var proto = HTMLMediaElement.prototype;
    var origAdd = proto.addEventListener;

    proto.addEventListener = function (type, listener, options) {
      if (!ENABLED) return origAdd.call(this, type, listener, options);
      if (BLOCKED_EVENTS.indexOf(type) !== -1) {
        // 静默丢弃，不注册
        return;
      }
      return origAdd.call(this, type, listener, options);
    };

    // 保留原始方法引用，供调试与回滚
    window.__CX_VIDEO_GUARD_ORIG__ = { addEventListener: origAdd };

    for (var i = 0; i < BLOCKED_EVENTS.length; i++) {
      var prop = "on" + BLOCKED_EVENTS[i];
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: true,
        get: function () {
          return null;
        },
        set: function () {
          /* 丢弃赋值 */
        },
      });
    }

    // 通知内容脚本：守卫已生效
    try {
      window.dispatchEvent(
        new CustomEvent("cx-video-guard-ready", { detail: { blocked: BLOCKED_EVENTS } })
      );
    } catch (_) {}

    console.info(
      "[学习通] 播放器守卫已生效，已屏蔽事件：",
      BLOCKED_EVENTS.join(", ")
    );
  } catch (err) {
    console.warn("[学习通] 播放器守卫安装失败：", err && err.message);
  }
})();
