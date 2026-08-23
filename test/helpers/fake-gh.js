// A scripted `gh` double. The real one is `execFileSync("gh", args)` — a
// synchronous shell-out returning stdout as a string and throwing on a non-zero
// exit, with the HTTP status in the message. mkGh() mimics both halves and, more
// importantly, *records* every call, so a test can assert what orch asked GitHub
// to do — including asking nothing at all, which is what `--dry` must do.
//
// script: an array of responses, consumed in call order. Each entry is either a
// string (stdout) or {error: "HTTP 404"} (thrown, mirroring execFileSync).
// Running past the end of the script throws — an unscripted call is a test bug,
// not a silent empty string.
export function mkGh(script = []) {
  const calls = [];
  let i = 0;
  const gh = (args, input) => {
    calls.push({ args, input });
    if (i >= script.length) throw new Error(`fake gh: unscripted call: gh ${args.join(" ")}`);
    const next = script[i++];
    if (next && next.error) throw new Error(next.error);
    return String(next ?? "");
  };
  gh.calls = calls;
  // Calls that change state on GitHub, as opposed to reads. `gh api -X PUT
  // .../merge` is the one that matters most: a --dry run that reaches it has
  // merged a real PR.
  gh.writes = () => calls.filter(({ args }) =>
    args.some((a) => /^-X$|^--method$/.test(a)) ||
    (["pr", "issue", "release"].includes(args[0]) &&
      ["create", "merge", "close", "comment", "edit", "review"].includes(args[1])));
  return gh;
}
