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
 * A key that is removed from the schema leaves a `null` **hole** rather than being
 * spliced out, for exactly the same reason: closing the gap would slide every later
 * entry down one and silently repoint saved patches. A hole reads as "not mapped"
 * through modTargetKey below, so a patch aiming at a parameter this build no longer
 * has lands inert instead of on some unrelated control.
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
  null, // 3  was 'decay' -- now envDecay, at 28
  'damping', // 4   > latched at note-on; a ringing note is unaffected
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
  null, // 13  was 'kickDecay' -- now envDecay, at 28
  'kickSweep', // 14
  'kickSweepTime', // 15
  'kickNoise', // 16
  'kickNoiseColor', // 17
  null, // 18  was 'snareDecay' -- now envDecay, at 28
  'snareNoise', // 19
  'snareNoiseColor', // 20
  'snareTone', // 21
  'snareBodyDecay', // 22
  null, // 23  was 'hatDecay' -- now envDecay, at 28
  'hatNoise', // 24
  'hatNoiseColor', // 25

  // The amplitude envelope, which every instrument is played through. Latched per
  // hit like the four above it, so sweeping one of these shapes the next note rather
  // than bending the one already sounding. envCurve is absent on purpose: it is a
  // toggle, and MOD_TARGETS excludes toggles for the reason given at the top.
  'envAttack', // 26
  'envHold', // 27  no effect on a track playing percussion -- see instruments.js
  'envDecay', // 28
];

/** The param key the LFO is pointed at, or null when unmapped. */
export function modTargetKey(index) {
  return MOD_TARGETS[Math.trunc(Number(index)) || 0] ?? null;
}
