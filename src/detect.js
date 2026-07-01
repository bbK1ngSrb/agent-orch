import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import localAdapters from "./adapters/local.js";

const REGISTERED_LOCAL_MODELS = new Set(Object.keys(localAdapters));

// Non-fatal detection pass for `orch init` (unlike preflight(), which throws
// on a missing CLI). Reports what's actually usable on this machine so the
// agents: pool isn't hand-edited blind. CLI agents are checked with `which`;
// local-llm models are read from claude-code-router's own config, since ccr
// being on PATH says nothing about which models it's configured to route to.
// ccr's current storage is a `config.sqlite` DB; `config.json` is only read
// once as a migration source when no sqlite config exists. There's no ccr
// CLI/API to dump the sqlite-backed config as JSON, and the DB's schema is
// undocumented and unstable across ccr versions, so this only reads the
// legacy config.json path — a sqlite config is reported as present-but-
// unreadable (not "missing") so the user gets pointed at the real fix
// instead of a wrong "not found" claim.
export function detectAgents(deps = {}) {
  const {
    which = (exe) => execFileSync("which", [exe], { stdio: "ignore" }),
    readFile = readFileSync,
    exists = existsSync,
    home = homedir(),
  } = deps;

  const found = [];
  const missing = [];

  for (const name of ["claude", "codex"]) {
    try { which(name); found.push(name); }
    catch { missing.push(`${name} (no CLI on PATH)`); }
  }

  try {
    which("ccr");
    try {
      const raw = JSON.parse(readFile(join(home, ".claude-code-router", "config.json"), "utf8"));
      const provider = (raw.Providers || []).find((p) => p.name === "local");
      const models = provider?.models || [];
      // Report the bare model name — that's what `orch agent add <name>` accepts
      // (agents: registry keys local models by name, not a "local:" prefix).
      // Only registered models (src/adapters/local.js) are actually usable by
      // orch; a configured-but-unregistered model would make `orch agent add`
      // fail with "unknown agent", so surface it as missing instead.
      const registered = models.filter((m) => REGISTERED_LOCAL_MODELS.has(m));
      const unregistered = models.filter((m) => !REGISTERED_LOCAL_MODELS.has(m));
      if (registered.length) registered.forEach((m) => found.push(m));
      if (unregistered.length) {
        unregistered.forEach((m) => missing.push(`${m} (configured in ccr but not a registered local model)`));
      }
      if (!models.length) missing.push("local (no models configured for provider \"local\")");
    } catch {
      if (exists(join(home, ".claude-code-router", "config.sqlite"))) {
        missing.push("local (configured via ~/.claude-code-router/config.sqlite, not readable here — run `ccr start` to open the web UI and see models, `orch agent add <model>` to register one)");
      } else {
        missing.push("local (no ~/.claude-code-router/config.json)");
      }
    }
  } catch {
    missing.push("local (ccr not on PATH)");
  }

  return { found, missing };
}

// "detected: claude, glm-4.5-air — not found: codex (no CLI on PATH)"
export function formatDetection({ found, missing }) {
  const parts = [`detected: ${found.length ? found.join(", ") : "none"}`];
  if (missing.length) parts.push(`not found: ${missing.join(", ")}`);
  return parts.join(" — ");
}
