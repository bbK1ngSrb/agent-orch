// Shape-only validation of the extracted work order (§3a). Validates structure,
// never meaning: free-text fields are attacker-controlled and handled as
// untrusted reference downstream (§3b, buildAuthorPrompt). Unknown fields are
// dropped, not trusted — the schema is an allowlist of keys.

export const WORK_ORDER_SHAPE = {
  title: "string",
  problem: "string",
  repro_steps: "string[]",
  suspected_paths: "string[]",
  acceptance_criteria: "string[]",
};

const NONEMPTY = new Set(["title", "problem"]);

export function validateWorkOrder(obj) {
  const errors = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["work order must be a plain object"] };
  }
  const workOrder = {};
  for (const [field, type] of Object.entries(WORK_ORDER_SHAPE)) {
    const v = obj[field];
    if (type === "string") {
      if (typeof v !== "string") {
        errors.push(`${field}: expected string`);
        continue;
      }
      if (NONEMPTY.has(field) && v.trim() === "") {
        errors.push(`${field}: must not be empty`);
        continue;
      }
      workOrder[field] = v;
    } else if (type === "string[]") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        errors.push(`${field}: expected string[]`);
        continue;
      }
      workOrder[field] = v;
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, workOrder };
}
