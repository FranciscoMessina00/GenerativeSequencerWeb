import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGIC_OPS,
  LOGIC_OP_NAMES,
  applyLogic,
  nextLogicOp,
} from '../src/sequencer/logic.js';

/**
 * The operator ids are positional -- applyLogic indexes LOGIC_OPS[id - 1] -- and patches
 * store them, so both the truth tables and the order they sit in are part of the file
 * format. These tests pin both.
 */

// ---------------------------------------------------------------------------
// Truth tables
// ---------------------------------------------------------------------------

const ID = { OR: 1, AND: 2, XOR: 3, NAND: 4 };

test('OR fires when either bit is set', () => {
  assert.equal(applyLogic(ID.OR, 0, 0), 0);
  assert.equal(applyLogic(ID.OR, 1, 0), 1);
  assert.equal(applyLogic(ID.OR, 0, 1), 1);
  assert.equal(applyLogic(ID.OR, 1, 1), 1);
});

test('AND fires only where both bits agree, thinning the pattern', () => {
  assert.equal(applyLogic(ID.AND, 0, 0), 0);
  assert.equal(applyLogic(ID.AND, 1, 0), 0);
  assert.equal(applyLogic(ID.AND, 0, 1), 0);
  assert.equal(applyLogic(ID.AND, 1, 1), 1);
});

test('XOR fires where the bits differ, displacing rather than adding hits', () => {
  assert.equal(applyLogic(ID.XOR, 0, 0), 0);
  assert.equal(applyLogic(ID.XOR, 1, 0), 1);
  assert.equal(applyLogic(ID.XOR, 0, 1), 1);
  assert.equal(applyLogic(ID.XOR, 1, 1), 0);
});

test('NAND is the inverse of AND, not NOR', () => {
  // The distinction that matters: NOR would be 1 only at (0,0). NAND is 1 everywhere
  // except (1,1), which is why it fills in rests rather than clearing hits.
  assert.equal(applyLogic(ID.NAND, 0, 0), 1);
  assert.equal(applyLogic(ID.NAND, 1, 0), 1);
  assert.equal(applyLogic(ID.NAND, 0, 1), 1);
  assert.equal(applyLogic(ID.NAND, 1, 1), 0);
});

test('NAND at zero probability triggers every step', () => {
  // With probability 0 the random bit is always 0, so NAND passes 1 whatever the
  // Euclidean pattern says -- a solid pulse train. Surprising enough to be worth
  // pinning, since it is what a user hears the moment they reach the fourth operator.
  for (const euclidBit of [0, 1]) {
    assert.equal(applyLogic(ID.NAND, euclidBit, 0), 1);
  }
});

test('bits are coerced, so truthy values behave like 1', () => {
  assert.equal(applyLogic(ID.AND, 1, true), 1);
  assert.equal(applyLogic(ID.AND, 1, undefined), 0);
});

// ---------------------------------------------------------------------------
// Ids and ordering
// ---------------------------------------------------------------------------

test('unknown ids fall back to OR rather than throwing', () => {
  // A stale or hand-edited patch must not be able to crash the step loop.
  for (const bad of [0, 5, -1, 99, NaN, undefined, null, 'nope']) {
    assert.equal(applyLogic(bad, 1, 0), 1, `id ${String(bad)} should behave as OR`);
    assert.equal(applyLogic(bad, 0, 0), 0, `id ${String(bad)} should behave as OR`);
  }
});

test('fractional ids floor rather than round', () => {
  // applyLogic floors, so 2.9 is still AND. Worth stating because the display path used
  // to round, which would have shown one operator while applying another.
  assert.equal(applyLogic(2.9, 1, 0), 0);
  assert.equal(applyLogic(2.0, 1, 0), 0);
});

test('ids are positional: LOGIC_OPS[i].id === i + 1', () => {
  // The invariant applyLogic's indexing depends on, and the reason reordering the table
  // would silently remap every saved patch.
  LOGIC_OPS.forEach((op, i) => assert.equal(op.id, i + 1));
});

test('LOGIC_OP_NAMES stays index-aligned with LOGIC_OPS', () => {
  assert.deepEqual(LOGIC_OP_NAMES, ['OR', 'AND', 'XOR', 'NAND']);
  LOGIC_OPS.forEach((op, i) => assert.equal(LOGIC_OP_NAMES[i], op.name));
});

test('nextLogicOp walks the table in order', () => {
  assert.equal(nextLogicOp(1), 2);
  assert.equal(nextLogicOp(2), 3);
  assert.equal(nextLogicOp(3), 4);
});

test('nextLogicOp wraps past the last operator', () => {
  assert.equal(nextLogicOp(4), 1);
});

test('one click per operator returns to where it started', () => {
  // What the cycling control relies on: the set is reachable and closed.
  let id = 1;
  const visited = [id];
  for (let i = 0; i < LOGIC_OPS.length - 1; i += 1) {
    id = nextLogicOp(id);
    visited.push(id);
  }
  assert.deepEqual(visited, [1, 2, 3, 4]);
  assert.equal(nextLogicOp(id), 1);
});

test('nextLogicOp lands on the first operator for an unrecognised id', () => {
  // Matching applyLogic's fallback, so a bad value repairs itself on the next click
  // instead of leaving the control stuck.
  for (const bad of [0, 5, -1, NaN, undefined, 'nope']) {
    assert.equal(nextLogicOp(bad), 1, `id ${String(bad)} should reset to OR`);
  }
});
