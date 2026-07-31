/**
 * The logic operators that combine the Euclidean step with the random/loop bit.
 *
 * Ids are 1-based because the control that selects them is a 1..4 integer param.
 */

export const LOGIC_OPS = [
  { id: 1, name: 'OR', apply: (a, b) => (a || b ? 1 : 0) },
  { id: 2, name: 'AND', apply: (a, b) => (a && b ? 1 : 0) },
  { id: 3, name: 'XOR', apply: (a, b) => (a !== b ? 1 : 0) },
  { id: 4, name: 'NAND', apply: (a, b) => (a && b ? 0 : 1) },
];

export const LOGIC_OP_NAMES = LOGIC_OPS.map((op) => op.name);

/** Apply operator `id` to two bits. Unknown ids fall back to OR rather than throw. */
export function applyLogic(id, euclidBit, randomBit) {
  const op = LOGIC_OPS[Math.floor(id) - 1] ?? LOGIC_OPS[0];
  return op.apply(Boolean(euclidBit), Boolean(randomBit));
}

/**
 * The next operator in the cycle, wrapping past the last back to the first.
 *
 * Here rather than in the control that clicks through it, because the order is not a
 * presentation choice: the ids are positional and patches store them, so a reordering
 * would silently remap every saved patch. Keeping the cycle beside the table it walks
 * means the two cannot drift apart.
 */
export function nextLogicOp(id) {
  const index = LOGIC_OPS.findIndex((op) => op.id === Math.floor(Number(id)));
  // An unrecognised id lands on the first operator, matching applyLogic's fallback.
  return LOGIC_OPS[(index + 1) % LOGIC_OPS.length].id;
}
