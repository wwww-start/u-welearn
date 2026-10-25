/**
 * 学习通考试控制器
 *
 * 与作业的区别（实测页面文案证实）：
 *   - 单题限时：「本题作答时间已用完，将进入下一题」
 *   - 分卷禁回跳：「进入下一个分卷后当前分卷标记题目将无法跳转查看」
 *   - 分卷限时：「当前分卷需限时耗尽才允许提交」
 *   - 可能启用人脸监考：「人脸比对中…」
 *
 * 因此策略是「就地作答、不回头、不早交」：
 *   1. 逐题在当前页完成，不依赖跳转
 *   2. 时间快到时才交卷（可选）
 *   3. 检测到人脸比对提示则暂停并提示人工
 */
(function () {
  "use strict";

  // 防重复注入
  if (window.CXExam) return;
  const state = {
    running: false,
    paused: false,
    logs: [],
    stats: { total: 0, answered: 0, failed: 0 },
  };

  function log(msg, level) {
    state.logs.push({ ts: Date.now(), level: level || "info", msg: String(msg) });
    if (state.logs.length > 400) state.logs.shift();
    (level === "error" ? console.warn : console.log)("[学习通·考试]", msg);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 检测危险提示（人脸/交卷确认/被取消） */
  function detectAlerts() {
    const t = document.body.innerText || "";
    if (/人脸比对|请正对摄像头|重新识别/.test(t)) return "face";
    if (/当前考试已被教师取消/.test(t)) return "cancelled";
    if (/当前分卷需限时耗尽才允许提交/.test(t)) return "no-early-submit";
    return null;
  }

  /** 当前可见题目（考试通常一屏一题） */
  function currentQuestion() {
    const all = window.CXModel.extractQuestions();
    if (!all.length) return null;
    // 取进入视口的那一题
    for (const q of all) {
      const r = q.node.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.7 && r.bottom > 0) return q;
    }
    return all[0];
  }

  /** 剩余作答时间（页面若显示倒计时则解析） */
  function readRemainingSeconds() {
    const t = document.body.innerText || "";
    // 形如 "剩余 12:34" / "考试剩余时间：00:59:30"
    const m = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    if (m[3] != null) {
      return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    }
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /** 自动提交 */
  async function submitExam() {
    const candidates = [
      ...document.querySelectorAll('a, button, .btn, [class*="submit"], [onclick*="submit"]'),
    ].filter(
      (el) => /交卷|提交试卷|确认交卷/.test((el.textContent || "").trim()) && el.offsetParent !== null
    );
    if (!candidates.length) {
      log("未找到交卷按钮", "warn");
      return false;
    }
    try {
      candidates[0].removeAttribute("href");
      candidates[0].click();
      log("已点击交卷");
      await sleep(800);
      // 二次确认
      for (const sel of ["#popok", ".confirm", '[class*="confirm"]']) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          break;
        }
      }
      return true;
    } catch (e) {
      log("交卷失败：" + e.message, "error");
      return false;
    }
  }

  /**
   * 主流程：逐题作答
   * 注意：考试有单题限时，所以每题作答要快；AI 超时即放弃该题，不阻塞。
   */
  async function run(options) {
    const opts = Object.assign(
      {
        relationType: window.CXAI.RELATION.EXAM,
        modelConfig: null,
        prefer: "coze",
        autoSubmit: false,       // 默认不自动交卷，避免踩"限时耗尽才允许提交"
        submitWhenRemainingSec: 60,
        perQuestionTimeoutMs: 25000,
        maxLoops: 200,
      },
      options || {}
    );

    if (state.running) return { ok: false, reason: "已在运行" };
    state.running = true;
    state.paused = false;

    const questions = window.CXModel.extractQuestions();
    state.stats.total = questions.length;
    log("扫描到 " + questions.length + " 道题");

    let loops = 0;
    while (loops++ < opts.maxLoops) {
      if (state.paused) {
        log("已暂停");
        break;
      }

      const alert = detectAlerts();
      if (alert === "face") {
        log("检测到人脸比对，暂停自动作答，请人工完成核验", "warn");
        state.paused = true;
        break;
      }
      if (alert === "cancelled") {
        log("考试已被教师取消", "error");
        state.paused = true;
        break;
      }

      const remain = readRemainingSeconds();
      if (
        opts.autoSubmit &&
        remain != null &&
        remain <= opts.submitWhenRemainingSec &&
        alert !== "no-early-submit"
      ) {
        log("剩余 " + remain + "s，准备交卷");
        await submitExam();
        break;
      }

      const q = currentQuestion();
      if (!q) {
        log("未找到当前题目，等待…", "warn");
        await sleep(1500);
        continue;
      }
      if (q.answers.mine) {
        log(`第 ${q.index ?? q.seq + 1} 题已作答，寻找下一题`);
        // 尝试点"下一题"
        const next = [...document.querySelectorAll('a,button,[class*="next"]')].find(
          (el) => /下一题|下一頁|下一/.test((el.textContent || "").trim()) && el.offsetParent !== null
        );
        if (next) next.click();
        await sleep(1200);
        continue;
      }

      // 作答（带每题超时）
      const ans = await Promise.race([
        window.CXAnswer.answerOne(q, {
          relationType: opts.relationType,
          modelConfig: opts.modelConfig,
          prefer: opts.prefer,
        }),
        sleep(opts.perQuestionTimeoutMs).then(() => ({ labels: [], texts: [], source: "timeout" })),
      ]);

      if (!ans.labels.length && !ans.texts.length) {
        state.stats.failed++;
        log(`第 ${q.index ?? q.seq + 1} 题未取得答案（${ans.source}）`, "error");
      } else {
        // 直接复用 answer 模块的填充逻辑
        const applied = await (async () => {
          let n = 0;
          if (ans.labels.length) {
            for (const label of ans.labels) {
              const opt = q.options.find((o) => o.label === label.toUpperCase());
              if (opt) {
                opt.node.removeAttribute("href");
                opt.node.click();
                n++;
                await sleep(100);
              }
            }
          }
          return n > 0;
        })();
        if (applied) {
          state.stats.answered++;
          log(`第 ${q.index ?? q.seq + 1} 题 ← ${ans.source}: ${ans.labels.join(",")}`);
        } else {
          state.stats.failed++;
        }
      }

      // 单题限时会自动跳下一题，这里也主动点一次
      const nextBtn = [...document.querySelectorAll('a,button,[class*="next"]')].find(
        (el) => /下一题|下一頁|下一/.test((el.textContent || "").trim()) && el.offsetParent !== null
      );
      if (nextBtn) {
        nextBtn.click();
        await sleep(1200);
      } else {
        await sleep(1000);
      }
    }

    state.running = false;
    return {
      ok: true,
      stats: { ...state.stats },
      paused: state.paused,
      logs: state.logs.slice(-60),
    };
  }

  window.CXExam = {
    run,
    submitExam,
    pause() {
      state.paused = true;
      return { ok: true };
    },
    status() {
      return {
        running: state.running,
        paused: state.paused,
        stats: { ...state.stats },
        remaining: readRemainingSeconds(),
        alert: detectAlerts(),
        logs: state.logs.slice(-40),
      };
    },
  };
})();
