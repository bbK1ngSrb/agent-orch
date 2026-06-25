import { execFileSync } from "node:child_process";
import { render } from "../prompts.js";
import { parseVerdict } from "../verdict.js";

const OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Returns { out, ok }. On nonzero exit / crash, still captures whatever the
// agent printed so audit() can fail safely instead of throwing.
function runCapture(bin, args, cwd) {
  try {
    return { out: execFileSync(bin, args, { cwd, ...OPTS }), ok: true };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}` || (e.message || "");
    return { out, ok: false };
  }
}

export function makeCliAdapter({ name, bin, buildArgs }) {
  return {
    name,
    bin, // the actual executable (may differ from name, e.g. local models run via `ccr`)
    async author(task, wd) {
      // Author must succeed; a failure here is a hard error (no commits made).
      execFileSync(bin, buildArgs(render("author", { task }), wd), { cwd: wd, ...OPTS });
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
    async audit(branch, wd) {
      // F4: never throw, and never trust a crashed/nonzero agent. A failed run
      // is a fail-safe DISAGREE even if it printed AGREE before dying.
      const { out, ok } = runCapture(bin, buildArgs(render("review", { branch }), wd), wd);
      if (!ok) return { decision: "DISAGREE", reason: "agent exited nonzero", raw: out };
      return parseVerdict(out); // unparseable/empty -> DISAGREE "unparseable verdict"
    },
  };
}
