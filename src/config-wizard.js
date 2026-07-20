import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parse, stringify } from "yaml";
import { DEFAULTS, normalizeMainConfig, validate } from "./config.js";
import { start as startInput } from "./tui/input.js";
import { box, C, colorEnabled } from "./tui/theme.js";

const TEXT = "text";
const NUMBER = "number";
const LIST = "list";
const ENUM = "enum";
const BOOL = "bool";

export const OPTION_CATALOG = [
  { keys: ["agents"], label: "agents", widget: LIST, explain: "The rotation pool used when no fixed roles are set. Keep at least one registered agent here; two or more lets orch split author and reviewer work." },
  { keys: ["author", "reviewer"], label: "author / reviewer", widget: TEXT, pair: true, explain: "Fixed roles bypass rotation for every task. Set both sides, or leave both blank so orch chooses from the agents pool." },
  { keys: ["authors", "reviewers"], label: "authors / reviewers", widget: LIST, pair: true, nullableList: true, explain: "Plural roles run multiple author branches and audit them with the reviewer list. Leave both blank unless you want parallel fixed-role fanout." },
  { keys: ["test"], label: "test command", widget: TEXT, explain: "Use auto to let orch detect the repo test command. Set a command when the project needs a specific gate." },
  { keys: ["reviseCap"], label: "revise cap", widget: NUMBER, min: 1, explain: "Maximum author/reviewer repair rounds before escalation. Higher values spend more time trying to self-heal; lower values fail faster." },
  { keys: ["stageTimeout"], label: "stage timeout", widget: NUMBER, min: 0, explain: "Per-stage timeout in minutes. Zero disables the watchdog; a positive value prevents a stuck agent stage from hanging forever." },
  { keys: ["baseBranch"], label: "base branch", widget: TEXT, explain: "The trunk branch orch bases task work on and eventually targets. Most repos use main; set this to your real integration trunk." },
  { keys: ["integrationBranch"], label: "integration branch", widget: TEXT, explain: "The local branch where green cycles land before main. Keeping it separate makes orch's accumulated work easy to inspect." },
  { keys: ["merge"], label: "merge strategy", widget: ENUM, choices: ["ff-only", "no-ff", "pr"], explain: "How each green cycle lands on the integration branch.", choiceExplain: {
    "ff-only": "Fast-forward keeps history linear, but the merge fails if the integration branch moved.",
    "no-ff": "No-ff keeps a merge commit per cycle so history clearly shows what orch landed.",
    pr: "PR mode skips local integration and opens one pull request per green cycle.",
  } },
  { keys: ["concurrency"], label: "concurrency", widget: NUMBER, min: 1, explain: "Maximum live cycles allowed in this repo. This protects the worktree area from too many simultaneous agent runs." },
  { keys: ["cheap.role"], label: "cheap role", widget: TEXT, nullable: true, explain: "Optional role spec used when cheap routing triggers. Leave blank to disable cheap-agent dispatch." },
  { keys: ["cheap.paths"], label: "cheap paths", widget: LIST, explain: "Globs that qualify a work order for the cheap role. Keep this narrow so only mechanical paths are routed away from the normal pool." },
  { keys: ["scope.maxLines"], label: "scope max lines", widget: NUMBER, min: 0, explain: "Optional changed-line budget for a task. Zero disables the limit; positive values make oversized changes stop early." },
  { keys: ["scope.ignore"], label: "scope ignore", widget: LIST, explain: "Globs ignored by scope checks. Generated files, locks, and snapshots usually belong here." },
  { keys: ["security.ignore"], label: "security ignore", widget: LIST, explain: "Globs exempt from the deterministic security scan. Only committed build artifacts (e.g. dist/**) belong here — never authored code." },
  { keys: ["github.mergeMethod"], label: "GitHub merge method", widget: ENUM, choices: ["squash", "merge", "rebase"], explain: "Merge method used when orch asks GitHub to merge an owned PR.", choiceExplain: {
    squash: "Squash produces one compact commit from the PR.",
    merge: "Merge preserves the PR branch commits and records a merge commit.",
    rebase: "Rebase replays commits linearly and requires a branch GitHub can rebase cleanly.",
  } },
  { keys: ["github.autoMergePr"], label: "GitHub auto-merge PR", widget: BOOL, choices: [false, true], explain: "Controls auto-merge on PRs orch opens or updates.", choiceExplain: {
    false: "A person still presses the merge button after checks and review are satisfied.",
    true: "orch asks GitHub to merge automatically once required checks pass.",
  } },
  { keys: ["main.autoMerge"], label: "main auto-merge", widget: BOOL, choices: [false, true], explain: "Controls direct auto-merge of the persistent integration-to-main PR.", choiceExplain: {
    false: "Keep this off when main should move only after human approval.",
    true: "Use this only when unattended updates to main are acceptable for the repo.",
  } },
  { keys: ["main.conflictResolution"], label: "main conflict resolution", widget: ENUM, choices: ["manual", "propose", "auto"], explain: "What orch does when the persistent integration-to-main PR is dirty.", choiceExplain: {
    manual: "Comment for a human and leave the dirty PR alone.",
    propose: "A resolver drafts a resolution for review without pushing.",
    auto: "Push only whitelisted metadata conflicts after the test gate passes; everything else is proposed.",
  } },
  { keys: ["main.conflictResolutionResolvers"], label: "main conflict resolvers", widget: LIST, nullableList: true, explain: "Optional role-spec pool for conflict resolution (rotate/fail over per conflict). Leave blank for the historical single-claude default." },
  { keys: ["main.autoResolveConflicts"], label: "main auto-resolve conflicts (deprecated)", widget: BOOL, choices: [false, true], explain: "Deprecated alias for conflict resolution. Prefer main.conflictResolution; true maps to auto, false to manual when no explicit mode is set.", choiceExplain: {
    false: "Legacy alias for conflictResolution: manual when no explicit mode is set.",
    true: "Legacy alias for conflictResolution: auto when no explicit mode is set.",
  } },
  { keys: ["main.autoResolveConflictPaths"], label: "main auto-resolve conflict paths", widget: LIST, explain: "Paths auto mode may push after a green gate. Non-matching conflicts stay proposed for humans even when resolution is auto." },
  { keys: ["release.autoBump"], label: "release auto-bump", widget: BOOL, choices: [false, true], explain: "Controls the automatic patch version bump and CHANGELOG entry after each integrated merge.", choiceExplain: {
    false: "orch never edits release files; the repo keeps its own release policy.",
    true: "Every integrated merge bumps the patch version and prepends a CHANGELOG entry.",
  } },
  { keys: ["docs.autoUpdate"], label: "docs auto-update", widget: BOOL, choices: [false, true], explain: "Controls follow-up documentation tasks after real code merges.", choiceExplain: {
    false: "Documentation changes remain manual.",
    true: "A successful code merge spawns a separate docs task using the configured prompt.",
  } },
  { keys: ["docs.prompt"], label: "docs prompt", widget: TEXT, explain: "Prompt used for the automatic docs follow-up task. Keep it broad enough to update affected docs without inventing unrelated changes." },
  { keys: ["docs.paths"], label: "docs paths", widget: LIST, explain: "Globs treated as documentation-only changes. These prevent docs-update tasks from recursively spawning more docs-update tasks." },
];

const QUIT = Symbol("quit");
const BACK = Symbol("back");

function get(obj, key) {
  return key.split(".").reduce((cur, part) => cur?.[part], obj);
}

function set(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    cur[part] = { ...(cur[part] || {}) };
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function cloneConfig(cfg) {
  return {
    ...cfg,
    agents: [...cfg.agents],
    authors: cfg.authors == null ? null : [...cfg.authors],
    reviewers: cfg.reviewers == null ? null : [...cfg.reviewers],
    cheap: { ...cfg.cheap, paths: [...cfg.cheap.paths] },
    scope: { ...cfg.scope, ignore: [...cfg.scope.ignore] },
    security: { ...cfg.security, ignore: [...cfg.security.ignore] },
    github: { ...cfg.github },
    main: {
      ...cfg.main,
      autoResolveConflictPaths: [...(cfg.main.autoResolveConflictPaths || [])],
      conflictResolutionResolvers: cfg.main.conflictResolutionResolvers == null
        ? null
        : cfg.main.conflictResolutionResolvers.map((r) => (typeof r === "string" ? r : { ...r })),
    },
    docs: { ...cfg.docs, paths: [...cfg.docs.paths] },
    release: { ...cfg.release },
  };
}

// Wizard in-memory configs already carry a resolved conflictResolution. Re-run
// normalize with that mode as explicit so propose/auto is not collapsed back to
// the deprecated boolean alias — unless the user is editing the alias itself.
function normalizeWizardConfig(cfg, entry = null) {
  const touchesAlias = Boolean(entry?.keys?.includes("main.autoResolveConflicts"));
  const userMain = touchesAlias ? {} : { conflictResolution: cfg.main.conflictResolution };
  normalizeMainConfig(cfg, userMain, {});
  validate(cfg);
  return cfg;
}

function roleSpecToString(spec) {
  if (spec == null) return spec;
  if (typeof spec === "string") return spec;
  return [spec.agent, spec.model, spec.effort].filter(Boolean).join(" ");
}

function parseList(input, nullable = false) {
  const items = String(input).split(",").map((s) => s.trim()).filter(Boolean);
  return nullable && items.length === 0 ? null : items;
}

export function applyChoice(entry, value, direction) {
  const choices = entry.widget === BOOL ? [false, true] : entry.choices;
  const i = choices.findIndex((choice) => choice === value);
  const step = direction === "left" ? -1 : 1;
  return choices[(Math.max(0, i) + step + choices.length) % choices.length];
}

export function parseAnswer(entry, answer, current) {
  const raw = answer === "" ? current : answer;
  if (entry.pair) {
    const values = Array.isArray(raw) ? raw : String(raw).split("|");
    return entry.keys.map((_key, i) => {
      const value = (values[i] ?? "").trim();
      return entry.widget === LIST ? parseList(value, entry.nullableList) : (value || null);
    });
  }
  if (entry.widget === NUMBER) return Number(raw);
  if (entry.widget === LIST) return parseList(raw, entry.nullableList);
  if (entry.widget === BOOL) return raw === true || raw === "true";
  if (entry.widget === ENUM) return raw;
  if (entry.nullable && String(raw).trim() === "") return null;
  return String(raw);
}

export function applyAnswer(cfg, entry, answer) {
  const next = cloneConfig(cfg);
  const current = entry.pair
    ? entry.keys.map((key) => formatValue(get(cfg, key))).join("|")
    : formatValue(get(cfg, entry.keys[0]));
  const value = parseAnswer(entry, answer, current);
  entry.keys.forEach((key, i) => set(next, key, entry.pair ? value[i] : value));
  return normalizeWizardConfig(next, entry);
}

export function validateCatalog(catalog = OPTION_CATALOG, defaults = DEFAULTS) {
  for (const entry of catalog) {
    for (const key of entry.keys) {
      if (get(defaults, key) === undefined) throw new Error(`catalog key missing from DEFAULTS: ${key}`);
    }
    if (entry.widget === ENUM) {
      for (const choice of entry.choices) normalizeWizardConfig(applyAnswer(defaults, entry, choice));
    }
  }
  normalizeWizardConfig(cloneConfig(defaults));
  return true;
}

export function configToYaml(cfg) {
  const out = cloneConfig(cfg);
  // Preserve the in-memory mode as explicit so serialization cannot flip propose/auto
  // back through the deprecated alias (Codex #3 / A4).
  normalizeMainConfig(out, { conflictResolution: out.main.conflictResolution }, {});
  validate(out);
  const main = { ...out.main };
  // Canonical field only — writing both alias + mode is what inverted behavior on reload.
  delete main.autoResolveConflicts;
  if (main.conflictResolutionResolvers != null) {
    main.conflictResolutionResolvers = main.conflictResolutionResolvers.map(roleSpecToString);
  }
  return stringify({ ...out, main });
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => (v && typeof v === "object" && v.agent != null ? roleSpecToString(v) : v)).join(", ");
  }
  if (value && typeof value === "object" && value.agent != null) return roleSpecToString(value);
  if (value == null) return "";
  return String(value);
}

function mergeConfig(user = {}) {
  return {
    ...DEFAULTS,
    ...user,
    cheap: { ...DEFAULTS.cheap, ...(user.cheap || {}) },
    scope: { ...DEFAULTS.scope, ...(user.scope || {}) },
    github: { ...DEFAULTS.github, ...(user.github || {}) },
    main: { ...DEFAULTS.main, ...(user.main || {}) },
    docs: { ...DEFAULTS.docs, ...(user.docs || {}) },
    release: { ...DEFAULTS.release, ...(user.release || {}) },
  };
}

function loadTarget(target) {
  if (existsSync(target)) {
    const user = parse(readFileSync(target, "utf8")) || {};
    const cfg = mergeConfig(user);
    // Same userMain tracking as load() so alias-only files map to conflictResolution: auto
    // instead of DEFAULTS' manual mode winning as "explicit".
    normalizeMainConfig(cfg, user.main || {}, {});
    validate(cfg);
    return cfg;
  }
  return normalizeWizardConfig(cloneConfig(DEFAULTS));
}

function renderPicker(entry, value, index, total, stream, error) {
  const choices = (entry.widget === BOOL ? [false, true] : entry.choices).map((choice) => (
    choice === value ? `[ ${choice} ]` : `  ${choice}  `
  )).join("   ");
  const explanation = entry.choiceExplain?.[String(value)] || entry.explain;
  const rows = [
    [{ text: entry.label, code: C.label }],
    [{ text: "" }],
    [{ text: `  ${choices}`, code: C.ok }],
    [{ text: "" }],
    ...explanation.match(/.{1,64}(?:\s|$)/g).map((text) => [{ text: text.trim() }]),
  ];
  if (error) rows.push([{ text: "" }], [{ text: error, code: C.fail }]);
  rows.push([{ text: "" }], [{ text: "← → change   Enter confirm   Esc back   q quit", code: C.muted }]);
  return `\x1Bc${box(` orch config ${index + 1}/${total} `, rows, { color: colorEnabled(stream), columns: stream.columns })}\n`;
}

async function pickDiscrete(entry, value, index, total, deps, error) {
  const { stdin, stdout, inputStart = startInput } = deps;
  return await new Promise((resolve) => {
    let current = value;
    let stop = () => {};
    const draw = (err) => stdout.write(renderPicker(entry, current, index, total, stdout, err));
    stop = inputStart(stdin, (event) => {
      if (event.type === "left" || event.type === "right") {
        current = applyChoice(entry, current, event.type);
        draw();
      } else if (event.type === "enter") {
        stop();
        resolve(current);
      } else if (event.type === "esc") {
        stop();
        resolve(BACK);
      } else if (event.type === "quit") {
        stop();
        resolve(QUIT);
      }
    });
    draw(error);
  });
}

async function askLine(entry, cfg, deps, error) {
  const { stdin, stdout } = deps;
  const current = entry.pair
    ? entry.keys.map((key) => formatValue(get(cfg, key))).join(" | ")
    : formatValue(get(cfg, entry.keys[0]));
  if (error) stdout.write(`orch config: ${error}\n`);
  stdout.write(`\n${entry.label}\n${entry.explain}\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await new Promise((resolve) => {
    rl.question("value: ", resolve);
    if (current) rl.write(current);
  });
  rl.close();
  if (answer.trim() === "q") return QUIT;
  return answer;
}

async function confirmOverwrite(target, deps) {
  if (!existsSync(target)) return true;
  const rl = createInterface({ input: deps.stdin, output: deps.stdout });
  const answer = await new Promise((resolve) => rl.question(`orch config: overwrite ${target}? (y/N) `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runConfigWizard({ repo = process.cwd(), configFile, stdin = process.stdin, stdout = process.stdout, inputStart = startInput } = {}) {
  if (!stdin.isTTY) throw new Error("orch config: interactive config needs a TTY");
  const target = configFile || join(repo, ".orch", "orch.yml");
  let cfg = loadTarget(target);
  let i = 0;
  let error = "";
  while (i < OPTION_CATALOG.length) {
    const entry = OPTION_CATALOG[i];
    try {
      if (entry.widget === ENUM || entry.widget === BOOL) {
        const picked = await pickDiscrete(entry, get(cfg, entry.keys[0]), i, OPTION_CATALOG.length, { stdin, stdout, inputStart }, error);
        if (picked === QUIT) return { status: "aborted" };
        if (picked === BACK) { i = Math.max(0, i - 1); error = ""; continue; }
        cfg = applyAnswer(cfg, entry, picked);
      } else {
        const answer = await askLine(entry, cfg, { stdin, stdout }, error);
        if (answer === QUIT) return { status: "aborted" };
        cfg = applyAnswer(cfg, entry, answer);
      }
      i += 1;
      error = "";
    } catch (e) {
      error = e.message;
    }
  }
  normalizeWizardConfig(cfg);
  if (!(await confirmOverwrite(target, { stdin, stdout }))) return { status: "aborted" };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, configToYaml(cfg));
  stdout.write(`orch: wrote ${target}\n`);
  return { status: "written", path: target, cfg };
}
