import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Static bash completion script. orch's arg parsing is hand-rolled (no
// yargs/commander), so this list is maintained by hand alongside printUsage()
// in cli.js — keep the two in sync when commands/flags change. test/completion.test.js
// enforces parity against PARSE_OPTIONS and the --help Commands block.
export const BASH_COMPLETION = `# orch bash completion
# Install: orch completion install (or) source <(orch completion bash)
_orch_completion() {
  local cur words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  local commands="init config agent task issue review pr release continue dashboard mcp upgrade update completion version help"
  local flags="-h --help --version --author --authors --reviewer --reviewers --cheap --file --config-file --allow-protected --allow-large-scope --dry --check --link --no-banner --no-tidy --json --limit --check-history --once --plain --refresh-ms --merge --pr"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    agent)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add build" -- "\${cur}") )
        return 0
      fi
      ;;
    completion)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "bash install" -- "\${cur}") )
        return 0
      fi
      ;;
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
