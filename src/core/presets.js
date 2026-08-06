/**
 * Factory patches -- the ones that ship with the instrument.
 *
 * Read-only by design. There is no save: this runs as a portfolio piece, where the
 * point is that a visitor hears something intentional immediately, not that they
 * accumulate their own patches. Nothing is written to the browser at all -- no
 * localStorage, no cookies -- so the instrument behaves identically for every
 * visitor and on every origin it is served from.
 *
 * WHERE THEY LIVE
 *
 * `presets/factory.json`, committed to the repo and fetched once at startup. Adding
 * a patch means appending to that file's `presets` array; no code changes, and no
 * build step to run.
 *
 * AUTHORING A NEW ONE
 *
 * Dial the instrument in, then click Export in the header: it downloads a
 * `{ "name": "...", "patch": { ... } }` file, ready to paste into
 * `presets/factory.json` as a new array entry. Including the seed is what makes the
 * patch replay note for note rather than merely restoring the same settings.
 *
 * The same thing is reachable from the devtools console, for scripting it:
 *
 *     __seq.presets.toJSON({ name: '...', patch: __seq.store.snapshot(__seq.rngs.map((r) => r.seed)) })
 */

/** Fetched relative to the document, so it works under a project subpath. */
const FACTORY_URL = './presets/factory.json';

/**
 * One entry from the factory file, once it has been checked for shape.
 * @typedef {{ name: string, patch: object }} FactoryPreset
 */

/**
 * Keep only entries that are actually usable, rather than trusting the file.
 *
 * A malformed entry is skipped instead of aborting the whole set: one bad patch
 * should cost that patch, not every other one. ParamStore.load() handles the
 * contents (clamping values, ignoring unknown keys), so this only has to be sure
 * there *is* a name and an object to hand it.
 *
 * @param {any} data parsed contents of the factory file
 * @returns {FactoryPreset[]}
 */
function validate(data) {
  const list = Array.isArray(data?.presets) ? data.presets : [];
  return list.filter(
    (/** @type {any} */ entry) =>
      entry
      && typeof entry.name === 'string'
      && entry.name.length > 0
      && entry.patch
      && typeof entry.patch === 'object',
  );
}

/**
 * Load the factory patches.
 *
 * Resolves to an empty array rather than rejecting if the file is missing or
 * malformed: the instrument is fully playable without any patch loaded, so a
 * fetch failure should leave the UI empty, not break startup.
 *
 * @returns {Promise<FactoryPreset[]>}
 */
export async function loadFactoryPresets(url = FACTORY_URL) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return [];
    return validate(await response.json());
  } catch {
    return [];
  }
}

/**
 * Pretty-printed, for authoring new factory patches -- see the header.
 * @param {object} snapshot
 */
export function toJSON(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parse patch text. Returns undefined rather than throwing on malformed input.
 * @param {string} text
 */
export function fromJSON(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export { validate as validateFactoryPresets };
