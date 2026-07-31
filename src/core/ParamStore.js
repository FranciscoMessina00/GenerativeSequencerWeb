import { PARAM_SCHEMA, normalizeParam, paramSpec } from './paramSchema.js';

/**
 * The authoritative value of every parameter, and the only thing that writes to
 * the engines.
 *
 * Before this existed the current value of a param lived in four places at once --
 * Track.params, AudioEngine.params, Scheduler.params, and each control's private
 * field -- with no copy being the real one. That made a control impossible to move
 * from code, which in turn made presets, MIDI and undo impossible.
 *
 * Two events, deliberately distinct:
 *
 *   param:change   a *request* to change a value (from a control, MIDI, a preset)
 *   param:changed  the *committed* value, announced after normalising
 *
 * Controls emit the first and listen to the second. That split is what makes
 * two-way binding safe: a control's own change comes back to it as `param:changed`,
 * and applying it calls setValue(), which by contract updates the display without
 * re-emitting. The echo is an idempotent redraw, never a loop.
 *
 * `target` decides scope. 'track' params are per-track, because two tracks want
 * different rhythms. 'voice' and 'transport' are global, matching the single
 * AudioEngine and Scheduler they drive.
 */

/** Bumped only if the snapshot *shape* changes; adding params does not need it. */
export const SNAPSHOT_VERSION = 1;

const TRACK_KEYS = PARAM_SCHEMA.filter((p) => p.target === 'track').map((p) => p.key);
const GLOBAL_KEYS = PARAM_SCHEMA.filter((p) => p.target !== 'track').map((p) => p.key);

function defaultsForKeys(keys) {
  const out = {};
  for (const key of keys) out[key] = paramSpec(key).def;
  return out;
}

export class ParamStore {
  /**
   * @param {object} [opts]
   * @param {import('./EventBus.js').EventBus} [opts.bus]
   * @param {number} [opts.trackCount] how many per-track value sets to hold
   * @param {(key: string, value: any, trackId: number, spec: object) => void} [opts.route]
   *   called for every committed change; where the engines get written
   */
  constructor({ bus, trackCount = 1, route } = {}) {
    this.bus = bus;
    this.route = route;
    this.trackValues = Array.from({ length: trackCount }, () => defaultsForKeys(TRACK_KEYS));
    this.globalValues = defaultsForKeys(GLOBAL_KEYS);
  }

  get trackCount() {
    return this.trackValues.length;
  }

  /** Which bag of values owns `key` -- one track's, or the global one. */
  #bagFor(key, trackId) {
    const spec = paramSpec(key);
    if (!spec) return null;
    if (spec.target !== 'track') return this.globalValues;
    return this.trackValues[trackId] ?? null;
  }

  get(key, trackId = 0) {
    return this.#bagFor(key, trackId)?.[key];
  }

  /**
   * Normalise, store, route to the engines, then announce.
   *
   * Returns true if the value actually changed. An unchanged value is dropped
   * before routing or announcing -- that dedupe is what keeps a control's own echo
   * from travelling any further than this method.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] store and route without emitting `param:changed`
   */
  set(key, value, trackId = 0, { silent = false } = {}) {
    const spec = paramSpec(key);
    if (!spec) return false;

    const bag = this.#bagFor(key, trackId);
    if (!bag) return false;

    const next = normalizeParam(key, value);
    if (bag[key] === next) return false;
    bag[key] = next;

    this.route?.(key, next, trackId, spec);
    if (!silent) this.#announce(key, next, trackId, spec);
    return true;
  }

  /**
   * Announce a committed value.
   *
   * `global` travels with the event because a listener bound to one track still has
   * to act on global changes -- filtering on trackId alone would silently drop bpm
   * and master gain the moment the visible track stops being track 0.
   */
  #announce(key, value, trackId, spec) {
    this.bus?.emit('param:changed', {
      trackId,
      key,
      value,
      global: spec.target !== 'track',
    });
  }

  /**
   * A complete, serialisable description of the instrument's state.
   *
   * The seed is part of the patch, not incidental: the generators are stochastic,
   * so without it a restored snapshot reproduces the same *settings* but a
   * different performance. With it the patch is genuinely reproducible, which is
   * the whole reason the RNG is seedable.
   */
  snapshot(seed) {
    return {
      version: SNAPSHOT_VERSION,
      seed,
      global: { ...this.globalValues },
      tracks: this.trackValues.map((bag) => ({ ...bag })),
    };
  }

  /**
   * Apply a snapshot. Returns the seed it carried, if any, so the caller can
   * decide whether to restore it (the store does not own the RNG).
   *
   * Unknown keys are ignored rather than rejected, and missing ones keep their
   * current value, so a snapshot saved before a schema change still loads. Every
   * value goes through the same normalisation as a live edit, so a hand-edited
   * file cannot push the engine outside its declared ranges.
   *
   * Writes are silent, then a single syncAll() announces everything -- otherwise
   * params that happen to already match would never reach the controls, since
   * `set` drops unchanged values.
   */
  load(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return undefined;

    for (const [key, value] of Object.entries(snapshot.global ?? {})) {
      if (paramSpec(key)?.target !== 'track') this.set(key, value, 0, { silent: true });
    }

    (Array.isArray(snapshot.tracks) ? snapshot.tracks : []).forEach((bag, trackId) => {
      if (trackId >= this.trackCount || !bag) return;
      for (const [key, value] of Object.entries(bag)) {
        if (paramSpec(key)?.target === 'track') this.set(key, value, trackId, { silent: true });
      }
    });

    this.syncAll();
    return typeof snapshot.seed === 'number' ? snapshot.seed : undefined;
  }

  /**
   * Push every held value back through routing and announcement.
   *
   * Used after loading a snapshot: `set` drops unchanged values, so params that
   * happened to already match would never reach the engines or the controls
   * without this.
   */
  syncAll() {
    for (const [key, value] of Object.entries(this.globalValues)) {
      const spec = paramSpec(key);
      this.route?.(key, value, 0, spec);
      this.#announce(key, value, 0, spec);
    }
    this.trackValues.forEach((bag, trackId) => {
      for (const [key, value] of Object.entries(bag)) {
        const spec = paramSpec(key);
        this.route?.(key, value, trackId, spec);
        this.#announce(key, value, trackId, spec);
      }
    });
  }
}

export { TRACK_KEYS, GLOBAL_KEYS };
