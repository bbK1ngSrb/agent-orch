import { execFileSync } from "node:child_process";
import { render } from "../prompts.js";
import { parseVerdict } from "../verdict.js";

const OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// True if CLI output looks like a Claude usage/rate-limit message. Keep this in
// sync with the regex in harness/orch-loop.sh (is_limit) — that wrapper waits
// out the limit and resumes, so the error must propagate, not get masked.
const LIMIT_RE = /usage limit|rate.?limit|limit (will )?reset|resets? at|\b429\b|overloaded/i;
export function isUsageLimit(text) {
  return LIMIT_RE.test(text || "");
}

// Returns { out, ok }. On nonzero exit / crash, still captures whatever the
// agent printed so audit() can fail safely instead of throwing — EXCEPT a usage
// limit, which we rethrow so the run aborts (rather than logging a bogus
// DISAGREE) and the harness can wait for reset and resume.
function runCapture(bin, args, cwd) {
  try {
    return { out: execFileSync(bin, args, { cwd, ...OPTS }), ok: true };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}` || (e.message || "");
    if (isUsageLimit(out)) throw new Error(`usage limit hit: ${out.trim().slice(0, 200)}`);
    return { out, ok: false };
  }
}

// Last few non-blank lines of an agent's failure output, trimmed for a verdict
// reason. Empty string when there's nothing useful, so the reason stays clean.
function detail(out) {
  const tail = (out || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
  return tail ? `: ${tail.slice(-300)}` : "";
}

export function makeCliAdapter({ name, bin, buildArgs }) {
  return {
    name,
    bin, // the actual executable (may differ from name, e.g. local models run via `ccr`)
    async author(task, wd, opts = {}) {
      // Author must succeed; a failure here is a hard error (no commits made).
      execFileSync(bin, buildArgs(render("author", { task }), wd, opts), { cwd: wd, ...OPTS });
      // The agent edits files in the worktree but cannot be trusted to commit
      // them — a `-p` run often leaves the work uncommitted, so the branch stays
      // at base and the auditor reviews an empty diff. Capture the work
      // deterministically: stage everything, and commit if anything is staged.
      // If the agent already committed (clean tree), this is a harmless no-op.
      execFileSync("git", ["add", "-A"], { cwd: wd, ...OPTS });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: wd, ...OPTS }).trim();
      if (staged) {
        execFileSync("git", ["commit", "-m", `orch: ${name} authored task`], { cwd: wd, ...OPTS });
      }
    },
    async audit(branch, wd, opts = {}) {
      // F4: never throw, and never trust a crashed/nonzero agent. A failed run
      // is a fail-safe DISAGREE even if it printed AGREE before dying.
      const { out, ok } = runCapture(bin, buildArgs(render("review", { branch }), wd, opts), wd);
      const parsed = parseVerdict(out);
      // A nonzero agent that still printed an explicit DISAGREE gave a real,
      // actionable review finding — keep it (don't bury it as "agent exited").
      // An AGREE from a crashed agent is untrusted and falls through to below.
      if (!ok && parsed.decision === "DISAGREE" && parsed.reason !== "unparseable verdict") return parsed;
      // Nonzero with no usable verdict (#33): flag it `agentError` so the engine
      // escalates instead of asking the author to revise a non-code failure.
      // Surface WHY it died (#31): a bad model id / missing flag lives in `out` —
      // fold a trimmed tail into the reason so the escalation names the cause.
      // Local files only.
      if (!ok) return { decision: "DISAGREE", reason: `agent exited nonzero${detail(out)}`, raw: out, agentError: true };
      return parsed; // unparseable/empty -> DISAGREE "unparseable verdict"
    },
  };
}
