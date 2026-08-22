import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS, FLAGS, SUBCOMMANDS } from "./schema.js";

// Bash completion, rendered from the command schema (src/schema.js) — the same
// declaration the parser and `orch --help` read, so tab-completion cannot offer
// a flag the parser rejects (or miss one it accepts). test/completion.test.js
// checks both renderers against the schema.
const COMMAND_WORDS = Object.keys(COMMANDS).join(" ");
const FLAG_WORDS = Object.entries(FLAGS)
  .flatMap(([name, f]) => (f.short ? [`-${f.short}`] : []).concat(`--${name}`))
  .join(" ");
const SUBCOMMAND_CASES = Object.entries(SUBCOMMANDS).map(([cmd, words]) => `    ${cmd})
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${words.join(" ")}" -- "\${cur}") )
        return 0
      fi
      ;;`).join("\n");

export const BASH_COMPLETION = `# orch bash completion
# Install: orch completion install (or) source <(orch completion bash)
_orch_completion() {
  local cur words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  local commands="${COMMAND_WORDS}"
  local flags="${FLAG_WORDS}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${SUBCOMMAND_CASES}
  esac

  COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
}
complete -F _orch_completion orch
`;

// Best-effort: postinstall calls this and must never fail the npm install.
export function installCompletion(deps = {}) {
  const mkdir = deps.mkdirSync || mkdirSync;
  const write = deps.writeFileSync || writeFileSync;
  const exists = deps.existsSync || existsSync;
  const home = deps.homedir ? deps.homedir() : homedir();
  try {
    const dir = join(home, ".orch");
    if (!exists(dir)) mkdir(dir, { recursive: true });
    const path = join(dir, "completion.bash");
    write(path, BASH_COMPLETION);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
