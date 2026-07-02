// Approximate public per-model pricing (USD per million tokens), used only to
// give an operator a rough cost estimate in run stats/history — NOT billing-
// accurate (ignores cache discounts, batch pricing, etc). Unknown models
// return null rather than guessing.
const PRICE_PER_MILLION = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gpt-5-1": { in: 5, out: 15 },
};

function findPrice(model) {
  if (!model) return null;
  const key = String(model).toLowerCase().replace(/\./g, "-");
  for (const [name, price] of Object.entries(PRICE_PER_MILLION)) {
    if (key.includes(name)) return price;
  }
  return null;
}

export function estimateCostUsd(model, { inputTokens = 0, outputTokens = 0 } = {}) {
  const price = findPrice(model);
  if (!price) return null;
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}
