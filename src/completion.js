import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS, FLAGS, GLOBAL_FLAGS, SUBCOMMANDS, SUBCOMMAND_FLAGS } from "./schema.js";

// Bash completion, rendered from the command schema (src/schema.js) — the same
// declaration the parser and `orch --help` read. Completion used to offer the
// union of every flag on every command (so `orch dashboard --m<TAB>` offered
// `--merge`, which the parser then rejects with exit 64) — this renders one
// flag list per command instead, from that command's own `flags` array, so
// tab-completion can never suggest input the parser refuses.
function flagWords(name) {
  const f = FLAGS[name];
  return (f.short ? [`-${f.short}`] : []).concat(`--${name}`);
}

const COMMAND_WORDS = Object.keys(COMMANDS).join(" ");
const GLOBAL_FLAG_WORDS = GLOBAL_FLAGS.flatMap(flagWords).join(" ");
// Flags that take a value: right after one of these, the next word is the
// value the user is typing, not another flag — offering flags there ("orch
// task --author <TAB>" suggesting "--dry") is noise the shell would then have
// to reject a second time.
const VALUE_FLAG_PATTERN = Object.entries(FLAGS)
  .filter(([, f]) => f.type !== "boolean")
  .map(([name]) => `--${name}`)
  .join("|");
// `agent` is excluded here and rendered separately below: its two
// subcommands (SUBCOMMAND_FLAGS) don't share a flag set, so offering the
// union at the "agent" case (as every other command does) would suggest
// --pr right after `orch agent add`, which the parser refuses.
const COMMAND_FLAG_CASES = Object.entries(COMMANDS)
  .filter(([cmd]) => cmd !== "agent")
  .map(([cmd, spec]) => `    ${cmd}) flags="${[...GLOBAL_FLAGS, ...spec.flags].flatMap(flagWords).join(" ")}" ;;`)
  .join("\n");
// Static per-subcommand, not per-invocation: `agent add --build` legally
// accepts the build-only flags (pr/author/reviewer, see validateAgentArgs in
// schema.js), but completion has no notion of "already typed --build" and
// always renders `agent add`'s narrower set — it under-offers rather than
// ever offering a flag the parser would refuse, which is the property this
// generator exists to guarantee.
const AGENT_SUBCOMMAND_FLAG_CASES = Object.entries(SUBCOMMAND_FLAGS)
  .map(([key, flags]) => `      ${key.split(" ")[1]}) flags="${[...GLOBAL_FLAGS, ...flags].flatMap(flagWords).join(" ")}" ;;`)
  .join("\n");
const SUBCOMMAND_CASES = Object.entries(SUBCOMMANDS).map(([cmd, words]) => `    ${cmd})
      COMPREPLY=( $(compgen -W "${words.join(" ")}" -- "\${cur}") )
      return 0
      ;;`).join("\n");

export const BASH_COMPLETION = `# orch bash completion
# Install: orch completion install (or) source <(orch completion bash)
_orch_completion() {
  local cur prev cmd cmd_index i w
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # A value-taking flag owns the very next word — never a flag suggestion.
  case "\${prev}" in
    ${VALUE_FLAG_PATTERN})
      return 0
      ;;
  esac

  local commands="${COMMAND_WORDS}"
  local global_flags="${GLOBAL_FLAG_WORDS}"

  # Find the command word: the first non-flag argument, skipping any global
  # flag that precedes it ("orch --dry task ..." is valid — parseArgs allows
  # options before positionals) and the value that follows a value-taking flag.
  cmd=""
  cmd_index=0
  i=1
  while [[ \${i} -lt \${COMP_CWORD} ]]; do
    w="\${COMP_WORDS[\${i}]}"
    if [[ "\${w}" == -* ]]; then
      case "\${w}" in
        ${VALUE_FLAG_PATTERN})
          i=$((i + 1))
          ;;
      esac
    else
      cmd="\${w}"
      cmd_index=\${i}
      break
    fi
    i=$((i + 1))
  done

  if [[ -z "\${cmd}" ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${global_flags}" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq \$((cmd_index + 1)) ]]; then
    case "\${cmd}" in
${SUBCOMMAND_CASES}
    esac
  fi

  local flags=""
  if [[ "\${cmd}" == "agent" ]]; then
    case "\${COMP_WORDS[\$((cmd_index + 1))]}" in
${AGENT_SUBCOMMAND_FLAG_CASES}
      *) flags="\${global_flags}" ;;
    esac
  else
    case "\${cmd}" in
${COMMAND_FLAG_CASES}
    esac
  fi

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
