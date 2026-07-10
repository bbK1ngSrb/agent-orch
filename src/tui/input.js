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
    case "tab":
      return { type: key.shift ? "shift-tab" : "tab" };
    case "return":
    case "enter":
      return { type: "enter" };
    case "escape":
      return { type: "esc" };
  }
  switch (str) {
    case "j":
      return { type: "down" };
    case "k":
      return { type: "up" };
    case "g":
      return { type: "top" };
    case "G":
      return { type: "bottom" };
    case "r":
      return { type: "refresh" };
    case "q":
      return { type: "quit" };
  }
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
