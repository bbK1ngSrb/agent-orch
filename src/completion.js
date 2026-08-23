import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS, FLAGS, GLOBAL_FLAGS, SUBCOMMANDS, SUBCOMMAND_FLAGS } from "./schema.js";
import { agentNames } from "./adapters/index.js";

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
// `completion` is excluded too: --dry is only legal on `completion install`
// (schema.js's validatePositionals refuses it on plain `completion [bash]`),
// so it gets the same narrower, subcommand-aware treatment below instead of
// the flat per-command flag list every other command uses.
const COMMAND_FLAG_CASES = Object.entries(COMMANDS)
  .filter(([cmd]) => cmd !== "agent" && cmd !== "completion")
  .map(([cmd, spec]) => `    ${cmd}) flags="${[...GLOBAL_FLAGS, ...spec.flags].flatMap(flagWords).join(" ")}" ;;`)
  .join("\n");
const COMPLETION_NO_DRY_FLAGS = [...GLOBAL_FLAGS, ...COMMANDS.completion.flags.filter((f) => f !== "dry")]
  .flatMap(flagWords).join(" ");
const COMPLETION_ALL_FLAGS = [...GLOBAL_FLAGS, ...COMMANDS.completion.flags].flatMap(flagWords).join(" ");
const AGENT_SUBCOMMAND_FLAG_CASES = Object.entries(SUBCOMMAND_FLAGS)
  .map(([key, flags]) => `      ${key.split(" ")[1]}) flags="${[...GLOBAL_FLAGS, ...flags].flatMap(flagWords).join(" ")}" ;;`)
  .join("\n");
// `agent add <name> --build` legally accepts the build-only flags too
// (validateAgentArgs in schema.js) — COMMANDS.agent.flags is already declared
// as that exact union — but ONLY when <name> is not already an adapter orch
// ships code for; a known name never builds regardless of `--build`, so the
// same validator refuses those flags there. `agentNames` (adapters/index.js)
// is the static list completion checks the typed <name> against below, so it
// never suggests a flag the parser has just been taught to refuse.
const AGENT_ADD_WITH_BUILD_FLAGS = [...GLOBAL_FLAGS, ...COMMANDS.agent.flags].flatMap(flagWords).join(" ");
const KNOWN_AGENT_PATTERN = agentNames.join("|");
// Right after "agent"/"completion" (subcommand not typed yet), a flag can
// still legally come next — "orch agent --dry add ..." and "orch completion
// --dry install" both parse fine, since parseArgs doesn't care where a flag
// sits relative to the subcommand word. Offering only the subcommand words
// here under-offered every flag common to all of that command's subcommands.
// agent: config-file/dry are shared by both "add" and "build" (SUBCOMMAND_FLAGS);
// completion: COMPLETION_NO_DRY_FLAGS already excludes --dry (illegal before
// "install" is known to be coming).
const AGENT_PRE_SUBCOMMAND_FLAGS = [...GLOBAL_FLAGS, ...SUBCOMMAND_FLAGS["agent add"].filter((f) => SUBCOMMAND_FLAGS["agent build"].includes(f))]
  .flatMap(flagWords).join(" ");
const SUBCOMMAND_PRE_FLAGS = { agent: AGENT_PRE_SUBCOMMAND_FLAGS, completion: COMPLETION_NO_DRY_FLAGS };
const SUBCOMMAND_CASES = Object.entries(SUBCOMMANDS).map(([cmd, words]) => `    ${cmd})
      COMPREPLY=( $(compgen -W "${words.join(" ")} ${SUBCOMMAND_PRE_FLAGS[cmd]}" -- "\${cur}") )
      return 0
      ;;`).join("\n");

export const BASH_COMPLETION = `# orch bash completion
# Install: orch completion install (or) source <(orch completion bash)
_orch_completion() {
  local cur prev cmd cmd_index i w j name known_agent wname
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # A value-taking flag owns the very next word — never a flag suggestion.
  case "\${prev}" in
    ${VALUE_FLAG_PATTERN})
      return 0
      ;;
  esac

  # A bare "--" (parseArgs' end-of-options marker, same as getopt's) means
  # nothing after it is ever read as a flag — the parser would only ever see
  # it as a positional. Offering flags past it suggests input the command
  # would silently treat as a plain argument instead of the option it looks
  # like.
  for ((i = 1; i < COMP_CWORD; i++)); do
    if [[ "\${COMP_WORDS[\${i}]}" == "--" ]]; then
      COMPREPLY=()
      return 0
    fi
  done

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
    # The subcommand ("add"/"build") isn't always the very next word — a
    # global flag can precede it ("orch agent --dry <TAB>" must still offer
    # "add build", not the global-flag fallback). Find it the same way the
    # command word itself was found above, skipping flags (and value-taking
    # flags' values) rather than assuming a fixed position.
    local sub="" sub_index=0
    i=$((cmd_index + 1))
    while [[ \${i} -lt \${COMP_CWORD} ]]; do
      w="\${COMP_WORDS[\${i}]}"
      if [[ "\${w}" == -* ]]; then
        case "\${w}" in
          ${VALUE_FLAG_PATTERN})
            i=$((i + 1))
            ;;
        esac
      else
        sub="\${w}"
        sub_index=\${i}
        break
      fi
      i=$((i + 1))
    done
    if [[ -z "\${sub}" ]]; then
      COMPREPLY=( $(compgen -W "add build" -- "\${cur}") )
      return 0
    fi
    case "\${sub}" in
${AGENT_SUBCOMMAND_FLAG_CASES}
      *) flags="\${global_flags}" ;;
    esac
    # "agent add --build" accepts the build-only flags too (--pr, author/
    # reviewer overrides, --allow-large-scope) — offer them once --build has
    # actually been typed, not before (validateAgentArgs, schema.js).
    # --build can legally appear anywhere before the name too ("orch agent
    # --build add widget --pr"), not just after "add" — scanning only from
    # sub_index missed that ordering and under-offered --pr.
    # But only when <name> isn't already a name orch ships an adapter for —
    # that never builds regardless of --build, so the build-only flags stay
    # invalid there too (validateAgentArgs refuses them unconditionally for a
    # known name); offering them would suggest input the parser rejects.
    if [[ "\${sub}" == "add" ]]; then
      name=""
      j=$((sub_index + 1))
      while [[ \${j} -lt \${COMP_CWORD} ]]; do
        w="\${COMP_WORDS[\${j}]}"
        if [[ "\${w}" == -* ]]; then
          case "\${w}" in
            ${VALUE_FLAG_PATTERN})
              j=$((j + 1))
              ;;
          esac
        else
          name="\${w}"
          break
        fi
        j=$((j + 1))
      done
      known_agent=0
      case "\${name}" in
        ${KNOWN_AGENT_PATTERN}) known_agent=1 ;;
      esac
      if [[ \${known_agent} -eq 0 ]]; then
        for ((i = cmd_index + 1; i < COMP_CWORD; i++)); do
          if [[ "\${COMP_WORDS[\${i}]}" == "--build" ]]; then
            flags="${AGENT_ADD_WITH_BUILD_FLAGS}"
            break
          fi
        done
      fi
    fi
  elif [[ "\${cmd}" == "completion" ]]; then
    # "install" can legally appear anywhere after the command too ("orch
    # completion --dry install"), so find the subcommand word (if any) the
    # same flag-skipping way "agent"'s sub is found above, instead of only
    # checking the literal next word.
    local sub=""
    for ((i = cmd_index + 1; i < COMP_CWORD; i++)); do
      w="\${COMP_WORDS[\${i}]}"
      if [[ "\${w}" != -* ]]; then
        sub="\${w}"
      fi
    done
    # --dry is illegal on plain "orch completion" but legal once "install" is
    # coming — and while the subcommand word hasn't been typed YET, it still
    # might be "install", so treating --dry as illegal the instant it's typed
    # (before "install" follows) rejected a perfectly legal ordering wholesale
    # ("orch completion --dry <TAB>" returned nothing). Only a subcommand word
    # that has actually landed and isn't "install" rules --dry out for good.
    if [[ -z "\${sub}" || "\${sub}" == "install" ]]; then
      flags="${COMPLETION_ALL_FLAGS}"
    else
      flags="${COMPLETION_NO_DRY_FLAGS}"
    fi
    # SUBCOMMAND_CASES above only offers "bash install" for the single word
    # right after "completion" ($cmd_index + 1) — once a flag has taken that
    # slot instead, the subcommand words must still be offered here.
    if [[ -z "\${sub}" ]]; then
      flags="${SUBCOMMANDS.completion.join(" ")} \${flags}"
    fi
  else
    case "\${cmd}" in
${COMMAND_FLAG_CASES}
    esac
  fi

  # A flag already typed but illegal for the command/subcommand that follows
  # ("orch --merge dashboard", "orch agent --build build") must not let
  # completion continue suggesting input as though the invocation were still
  # valid — the parser has already refused it by this point. parseArgs also
  # accepts "--flag=value" as one word; matching that literal word against
  # $flags (which only ever holds bare "--flag" names) always missed, so a
  # perfectly legal "orch task --author=claude <TAB>" wrongly looked illegal
  # and returned nothing. Strip a trailing "=value" before checking legality.
  i=1
  while [[ \${i} -lt \${COMP_CWORD} ]]; do
    w="\${COMP_WORDS[\${i}]}"
    if [[ "\${w}" == -* ]]; then
      wname="\${w%%=*}"
      if [[ " \${flags} " != *" \${wname} "* ]]; then
        COMPREPLY=()
        return 0
      fi
      case "\${w}" in
        ${VALUE_FLAG_PATTERN})
          i=$((i + 1))
          ;;
      esac
    fi
    i=$((i + 1))
  done

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
