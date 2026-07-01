import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Non-fatal detection pass for `orch init` (unlike preflight(), which throws
// on a missing CLI). Reports what's actually usable on this machine so the
// agents: pool isn't hand-edited blind. CLI agents are checked with `which`;
// local-llm models are read from claude-code-router's own config, since ccr
// being on PATH says nothing about which models it's configured to route to.
// ccr's current storage is a `config.sqlite` DB; `config.json` is only its
// legacy/migration format, so a JSON parse failure doesn't mean "no config"
// — check for the sqlite file before reporting local as unconfigured.
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
      if (models.length) models.forEach((m) => found.push(m));
      else missing.push("local (no models configured for provider \"local\")");
    } catch {
      if (exists(join(home, ".claude-code-router", "config.sqlite"))) {
        missing.push("local (configured via ~/.claude-code-router/config.sqlite — run `ccr ui` to see models, `orch agent add <model>` to register one)");
      } else {
        missing.push("local (no ~/.claude-code-router/config.json)");
      }
    }
  } catch {
    missing.push("local (ccr not on PATH)");
  }

  return { found, missing };
}

// "detected: claude, codex, glm-4.5-air — not found: codex (no CLI on PATH)"
export function formatDetection({ found, missing }) {
  const parts = [`detected: ${found.length ? found.join(", ") : "none"}`];
  if (missing.length) parts.push(`not found: ${missing.join(", ")}`);
  return parts.join(" — ");
}
