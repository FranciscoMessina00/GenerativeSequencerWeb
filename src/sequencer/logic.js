/**
 * The logic operators that combine the Euclidean step with the random/loop bit.
 *
 * Indices are 1-based to match the original's `~op` knob
 * (`TriggerWithGlide.scd:291-351`) and the labels drawn by the Processing GUI
 * (`Vista.pde:297-310`).
 */

export const LOGIC_OPS = [
  { id: 1, name: 'OR', apply: (a, b) => (a || b ? 1 : 0) },
  { id: 2, name: 'AND', apply: (a, b) => (a && b ? 1 : 0) },
  { id: 3, name: 'XOR', apply: (a, b) => (a !== b ? 1 : 0) },
  { id: 4, name: 'NAND', apply: (a, b) => (a && b ? 0 : 1) },
];

export const LOGIC_OP_NAMES = LOGIC_OPS.map((op) => op.name);

/**
 * Apply operator `id` to two bits. Unknown ids fall back to OR, matching the
 * source's `case` which leaves `~trigg` untouched rather than erroring.
 */
export function applyLogic(id, euclidBit, randomBit) {
  const op = LOGIC_OPS[Math.floor(id) - 1] ?? LOGIC_OPS[0];
  return op.apply(Boolean(euclidBit), Boolean(randomBit));
}
