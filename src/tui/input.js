import { emitKeypressEvents } from "node:readline";

function normalize(str, key = {}) {
  if (key.ctrl && key.name === "c") return { type: "quit", ctrlC: true };
  if (key.name === "tab") return { type: key.shift ? "shift-tab" : "tab" };
  switch (key.name) {
    case "down":
      return { type: "down" };
    case "up":
      return { type: "up" };
    case "return":
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
  return { type: "char", value: str };
}

export function start(stdin = process.stdin, onKey = () => {}) {
  if (!stdin.isTTY) return () => {};
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  const listener = (str, key) => onKey(normalize(str, key));
  stdin.on("keypress", listener);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stdin.off("keypress", listener);
    stdin.setRawMode(false);
    stdin.pause();
  };
}
