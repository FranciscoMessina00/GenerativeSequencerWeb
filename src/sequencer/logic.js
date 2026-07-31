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
