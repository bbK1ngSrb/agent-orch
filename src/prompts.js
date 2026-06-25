import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Substitute {{var}} placeholders; unknown keys are left untouched.
export function renderTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

// Load prompts/<name>.md and fill its placeholders with `vars`.
export function render(name, vars = {}) {
  const tpl = readFileSync(join(HERE, "prompts", `${name}.md`), "utf8");
  return renderTemplate(tpl, vars);
}
