// Per-cycle session id. pid disambiguates across processes; the monotonic
// counter disambiguates multiple cycles in one process. No Math.random/Date
// needed — this is enough and stays readable in branch names.
let counter = 0;
export function newSid() {
  return `${process.pid}-${(counter++).toString(36)}`;
}
