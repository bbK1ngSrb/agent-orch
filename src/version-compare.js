export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b || "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
