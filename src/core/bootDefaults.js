import { INSTRUMENTS } from '../audio/instruments.js';

/**
 * The handful of defaults that differ *between* tracks.
 *
 * `defaultsFor()` gives every track the same bag, which is right for almost
 * everything -- but not for the two things that are only meaningful as a set. Four
 * tracks all audible on a cold boot would stack four copies of the same Euclid
 * pattern at four times the level, and four tracks all playing the same instrument
 * would make the four pages four voices of one instrument rather than four
 * instruments.
 *
 * It lives here rather than inline in main.js because it has three callers that must
 * agree: the bootstrap, the script that regenerates presets/factory.json, and the
 * test that asserts the shipped patch has not drifted from the defaults. Restating it
 * in each was already a duplication with one entry in it; it would be worse with two.
 *
 * Announced rather than silent, and therefore called *after* the controls exist: these
 * are ordinary committed values, and the tab strip's mute dot follows `param:changed`
 * like everything else. A silent write here would leave the UI disagreeing with the
 * store from the first frame.
 */
export function applyBootDefaults(store) {
  // Track 0 is the one you hear. Every track defaults to muted (see paramSchema.js)
  // precisely so that this is one explicit decision in one place.
  store.set('mute', false, 0);

  // A string and a drum kit. Assigned by position rather than declared in the schema
  // because `def` is one value for every track -- and any track can be changed to any
  // instrument afterwards, so this is a starting point rather than a rule. Tracks past
  // the registry keep the default.
  INSTRUMENTS.forEach((instrument, trackId) => {
    store.set('instrument', instrument.id, trackId);
  });
}
