export function totalUsage(runStats = []) {
  let tokens = 0;
  let costUsd = 0;
  let hasCost = false;
  for (const s of runStats) {
    tokens += Number(s.tokens) || 0;
    if (typeof s.costUsd === "number") { costUsd += s.costUsd; hasCost = true; }
  }
  return { tokens, costUsd: hasCost ? costUsd : null };
}

export function formatInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsd(n) {
  const v = Number(n) || 0;
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

export function formatUsage(usage) {
  const cost = usage.costUsd != null ? `, ~${formatUsd(usage.costUsd)}` : "";
  return `${formatInt(usage.tokens)} tokens${cost}`;
}
