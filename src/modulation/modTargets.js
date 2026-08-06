/**
 * What the LFO is allowed to modulate.
 *
 * The array index *is* the stored value of the `lfoTarget` param, which is what lets
 * the target be an ordinary numeric schema entry and ride the existing snapshot,
 * defaults and preset machinery untouched. So: **append only.** Inserting or
 * reordering silently repoints every saved patch at a different parameter.
 *
 * Index 0 is "not mapped", so the LFO ships inert.
 *
 * What is missing from this list is missing on purpose:
 *
 *   - Enumerated and toggle params (scale, stepDivision, stepMod, logicOp, instrument
 *     and every *Loop*) snap to the nearest member or coerce to a boolean, so a smooth
 *     offset becomes a jump between unrelated settings rather than a sweep. For
 *     `instrument` that jump would swap the whole voice mid-phrase.
 *   - steps / pulses / rotation rebuild the Euclidean pattern and repaint the ring on
 *     every write, and change the cycle length under the playhead.
 *   - trigLoopLength / trigPerm / noteLoopLength / notePerm / velLoopLength re-capture
 *     the loop from live history on every write -- modulating them would re-randomise
 *     the frozen loop continuously, destroying the thing the loop exists to hold.
 *   - modes is the CPU/quality knob, so modulating it changes cost, not timbre.
 *
 * Note the split in how these are consumed, which is why the LFO is sampled once per
 * step rather than per frame: grainPitch and grainDryWet are live k-rate AudioParams,
 * the four string params are latched when a note is built, and the rest are read
 * fresh inside Track.step(). None of them is read more often than once a step.
 */
export const MOD_TARGETS = [
  null, // 0 -- not mapped
  'modBias', // 1  pluck position: the most audible target on the string
  'stiffness', // 2  \
  'decay', // 3   \ latched at note-on; a ringing note is unaffected
  'damping', // 4   /
  'pluckSoftness', // 5 /
  'grainPitch', // 6  live AudioParam, already smoothed over 10 ms
  'grainDryWet', // 7  ditto
  'noteBias', // 8  transposes, and re-roots the scale with it
  'noteSpread', // 9  \
  'velBias', // 10  | read per step inside Track.step()
  'velSpread', // 11  |
  'probability', // 12 /

  // The percussion voices. Latched per hit, like the string's four -- a hit already
  // sounding is unaffected, so the LFO shapes the next one rather than bending this
  // one. Only the instrument a track actually plays has its panel on screen, so
  // assign mode can only ever point the LFO at a parameter that does something.
  'kickDecay', // 13
  'kickSweep', // 14
  'kickSweepTime', // 15
  'kickNoise', // 16
  'kickNoiseColor', // 17
  'snareDecay', // 18
  'snareNoise', // 19
  'snareNoiseColor', // 20
  'snareTone', // 21
  'snareBodyDecay', // 22
  'hatDecay', // 23
  'hatNoise', // 24
  'hatNoiseColor', // 25
];

/** The param key the LFO is pointed at, or null when unmapped. */
export function modTargetKey(index) {
  return MOD_TARGETS[Math.trunc(Number(index)) || 0] ?? null;
}
