import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Non-fatal detection pass for `orch init` (unlike preflight(), which throws
// on a missing CLI). Reports what's actually usable on this machine so the
// agents: pool isn't hand-edited blind. CLI agents are checked with `which`;
// local-llm models are read from claude-code-router's own config, since ccr
// being on PATH says nothing about which models it's configured to route to.
export function detectAgents(deps = {}) {
  const {
    which = (exe) => execFileSync("which", [exe], { stdio: "ignore" }),
    readFile = readFileSync,
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
      if (models.length) models.forEach((m) => found.push(`local:${m}`));
      else missing.push("local (no models configured for provider \"local\")");
    } catch {
      missing.push("local (no ~/.claude-code-router/config.json)");
    }
  } catch {
    missing.push("local (ccr not on PATH)");
  }

  return { found, missing };
}

// "detected: claude, codex, local:glm-4.5-air — not found: codex (no CLI on PATH)"
export function formatDetection({ found, missing }) {
  const parts = [`detected: ${found.length ? found.join(", ") : "none"}`];
  if (missing.length) parts.push(`not found: ${missing.join(", ")}`);
  return parts.join(" — ");
}
