import { watch } from "node:fs";
import { render as renderDashboard } from "../dashboard.js";
import { colorEnabled } from "./theme.js";
import { enter, leave, paintFrame, registerRestore } from "./screen.js";
import { start as startInput } from "./input.js";

function intervalMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

export function run(orchDir, opts = {}, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stdin = deps.stdin || process.stdin;
  const proc = deps.process || process;
  const render = deps.render || renderDashboard;
  const refreshMs = intervalMs(opts.refreshMs);
  const setTimer = deps.setInterval || setInterval;
  const clearTimer = deps.clearInterval || clearInterval;
  const setDelay = deps.setTimeout || setTimeout;
  const clearDelay = deps.clearTimeout || clearTimeout;
  const watchDir = deps.watch || watch;

  let timer = null;
  let watcher = null;
  let watchDelay = null;
  let stopInput = () => {};
  let unregisterRestore = () => {};
  let previousLineCount = 0;
  let previousFrame = null;
  let done = false;

  return new Promise((resolve, reject) => {
    const cleanup = (err = null) => {
      if (done) return;
      done = true;
      if (timer) clearTimer(timer);
      if (watchDelay) clearDelay(watchDelay);
      try { watcher?.close?.(); } catch {}
      stopInput();
      proc.off?.("SIGINT", onSigint);
      proc.off?.("SIGTERM", onSigterm);
      proc.off?.("uncaughtException", onUncaught);
      proc.off?.("unhandledRejection", onUnhandled);
      unregisterRestore();
      leave(stdout);
      if (err) reject(err);
      else resolve();
    };

    const tick = () => {
      const frame = render(orchDir, {
        historyLimit: opts.historyLimit,
        repo: opts.repo,
        checkHistory: opts.checkHistory,
        color: colorEnabled(stdout),
        columns: stdout.columns,
      });
      if (frame === previousFrame) return;
      previousFrame = frame;
      previousLineCount = paintFrame(stdout, frame, previousLineCount);
    };

    const scheduleTick = () => {
      if (watchDelay) clearDelay(watchDelay);
      watchDelay = setDelay(() => {
        watchDelay = null;
        try { tick(); } catch (e) { cleanup(e); }
      }, 100);
    };

    const onKey = (key) => {
      if (key.type === "quit") cleanup();
      if (key.type === "refresh") {
        try { tick(); } catch (e) { cleanup(e); }
      }
    };
    const onSigint = () => cleanup();
    const onSigterm = () => cleanup();
    const onUncaught = (err) => cleanup(err);
    const onUnhandled = (err) => cleanup(err instanceof Error ? err : new Error(String(err)));

    try {
      enter(stdout);
      unregisterRestore = registerRestore(stdout);
      stopInput = startInput(stdin, onKey);
      proc.on?.("SIGINT", onSigint);
      proc.on?.("SIGTERM", onSigterm);
      proc.on?.("uncaughtException", onUncaught);
      proc.on?.("unhandledRejection", onUnhandled);
      try { watcher = watchDir(orchDir, { persistent: false }, scheduleTick); } catch {}
      tick();
      timer = setTimer(() => {
        try { tick(); } catch (e) { cleanup(e); }
      }, refreshMs);
    } catch (e) {
      cleanup(e);
    }
  });
}
