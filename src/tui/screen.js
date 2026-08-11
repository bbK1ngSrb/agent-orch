const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const ERASE_TO_EOL = "\x1b[K";
const ERASE_TO_END = "\x1b[J";

function write(out, s) {
  out.write(s);
}

export function enter(out = process.stdout) {
  write(out, ENTER_ALT_SCREEN);
  write(out, HIDE_CURSOR);
}

export function leave(out = process.stdout) {
  write(out, SHOW_CURSOR);
  write(out, LEAVE_ALT_SCREEN);
}

export function paintFrame(out = process.stdout, text = "", prevLineCount = 0) {
  const lines = String(text).split("\n");
  // One batched write for the whole frame: a syscall per line (60+ per
  // repaint) both wastes work and can tear mid-frame.
  write(out, CURSOR_HOME +
    lines.map((line) => line + ERASE_TO_EOL).join("\n") +
    (lines.length < prevLineCount ? ERASE_TO_END : ""));
  return lines.length;
}

// Repaint a single 1-based row in place. Used for the footer clock, which
// changes every second while the body above it usually does not.
export function paintLineAt(out = process.stdout, row = 1, text = "") {
  write(out, `\x1b[${Math.max(1, row)};1H${String(text)}${ERASE_TO_EOL}`);
}

export function registerRestore(out = process.stdout) {
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    leave(out);
  };
  process.on("exit", restore);

  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    process.off("exit", restore);
  };
}
