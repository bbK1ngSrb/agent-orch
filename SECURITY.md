# Security Policy

> **agent-orch is an educational artifact and is _not_ intended for production use.**
> See [`LICENSE`](LICENSE) (PolyForm Noncommercial 1.0.0) and the [`README`](README.md)
> for scope and disclaimers. This policy still applies — security reports are welcome.

## Supported versions

There are no released, versioned builds. Security fixes land on the default
branch (`main`) only. Run from a current checkout of `main`; older commits and
forks are not maintained.

| Version            | Supported          |
| ------------------ | ------------------ |
| `main` (latest)    | :white_check_mark: |
| any earlier commit | :x:                |

**Runtime:** Node.js `>=18` (per `package.json`). Reports against unsupported
runtimes will be assessed but may be declined.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately through GitHub's coordinated disclosure flow:

1. Go to the **[Security tab](https://github.com/bbk1ng/agent-orch/security)**
   of the repository.
2. Click **"Report a vulnerability"** to open a private security advisory.
3. Include the details below.

If you cannot use GitHub advisories, contact the maintainer privately and we will
open an advisory on your behalf.

### What to include

- A clear description of the issue and its impact.
- A minimal reproduction (commands, inputs, config, or a short PoC).
- Affected file(s) / function(s) and the commit you tested against.
- Your assessment of severity and any known mitigations.

## What to expect

- **Acknowledgement:** within 7 days.
- **Triage / initial assessment:** within 14 days.
- **Fix or mitigation:** prioritised by severity once confirmed.
- We will keep you updated and credit you in the advisory unless you ask otherwise.
- Please give us a reasonable window to fix before any public disclosure.

## Scope

In scope — defects in this repository that can cause real harm, for example:

- **Command / argument injection** in the spawn paths (`gate.js`, `git.js`,
  `github.js`) — e.g. unsanitised branch names or work-order content reaching a
  shell or an executable's argv.
- **Path traversal** in worktree / reviews directory handling
  (`notify.js`, `cli.js`).
- **Secret/credential leakage** — tokens or credential files written to logs,
  transcripts, or worktrees.
- **Privilege or trust-boundary escapes** in the author → cross-audit → merge
  pipeline (e.g. a malicious author bypassing the test gate or review gate).

Out of scope:

- Anything that requires already-trusted local shell access equivalent to the
  user running the tool (this tool runs arbitrary agent-authored code by design).
- Vulnerabilities in third-party dependencies — report those upstream
  (we depend only on `yaml`).
- Use in production environments — explicitly unsupported (see `LICENSE` / `README`).
- Theoretical issues with no demonstrated impact.

Thank you for helping keep agent-orch and its users safe.
