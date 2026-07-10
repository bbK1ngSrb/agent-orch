import { emitKeypressEvents } from "node:readline";

// Translate a raw readline keypress (str, key) into a normalized event, or
// null to ignore. Ctrl-C arrives as a keypress (0x03) under raw mode, not
// SIGINT, so it must be handled here or the user is trapped.
export function normalizeKey(str, key = {}) {
  if (key.ctrl && key.name === "c") return { type: "quit", ctrlC: true };
  switch (key.name) {
    case "up":
      return { type: "up" };
    case "down":
      return { type: "down" };
    case "left":
      return { type: "left" };
    case "right":
      return { type: "right" };
    case "tab":
      return { type: key.shift ? "shift-tab" : "tab" };
    case "return":
    case "enter":
      return { type: "enter" };
    case "escape":
      return { type: "esc" };
    case "backspace":
      return { type: "backspace" };
  }
  // Shortcut keys carry their printable char as `value` too, so a filter/input
  // mode can type them literally instead of firing the shortcut.
  switch (str) {
    case "/":
      // Carries its printable char so filter mode can type it literally (branch
      // names like `pr/done`); only fires the shortcut outside filter mode.
      return { type: "filter", value: "/" };
    case "j":
      return { type: "down", value: "j" };
    case "k":
      return { type: "up", value: "k" };
    case "g":
      return { type: "top", value: "g" };
    case "G":
      return { type: "bottom", value: "G" };
    case "r":
      return { type: "refresh", value: "r" };
    case "?":
      return { type: "help" };
    case "q":
      return { type: "quit", value: "q" };
  }
  if (/^[123]$/.test(str)) return { type: "panel", index: Number(str) - 1, value: str };
  if (str) return { type: "char", value: str };
  return null;
}

// Enter raw mode and stream normalized key events to onKey. Returns a stop()
// that restores cooked mode. No-op (returns a no-op stop) on a non-TTY stdin.
export function start(stdin = process.stdin, onKey = () => {}) {
  if (!stdin.isTTY) return () => {};
  emitKeypressEvents(stdin);
  const listener = (str, key) => {
    const event = normalizeKey(str, key);
    if (event) onKey(event);
  };
  stdin.on("keypress", listener);
  stdin.setRawMode(true);
  stdin.resume();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stdin.setRawMode(false);
    stdin.pause();
    stdin.off("keypress", listener);
  };
}
