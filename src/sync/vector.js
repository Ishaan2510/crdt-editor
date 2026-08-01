/** Does this version vector already account for this operation? */
export function covers(vector, op) {
  return (vector[op.id.site] ?? -1) >= op.id.lamport;
}

/** Everything in the log that the other side is missing. */
export function missingFrom(log, vector) {
  return log.filter(op => !covers(vector, op));
}