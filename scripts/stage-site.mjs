#!/usr/bin/env node
/**
 * Copies the published site into a directory, and is the single definition of what
 * "the site" is.
 *
 * Both deploys call this: ci.yml stages a branch preview for Cloudflare Pages, and
 * deploy.yml stages a release for GitHub Pages. They used to hold a copy each of the
 * same four `cp` lines, with a comment admitting the duplication -- and two copies
 * drifting apart would mean the preview site and the production site were no longer
 * the same app, which is the one thing a preview exists to rule out.
 *
 * Not a build step: it copies files exactly as they are, which is what the README
 * promises deployment does. Nothing is transformed, bundled or minified, and running
 * it locally is how you see precisely what would be published.
 *
 *   node scripts/stage-site.mjs _site
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * An allow-list, not an exclude-list: only what is named here ever reaches the
 * published site, so a file added at the repo root later -- a stray config, a
 * note-to-self, a scratch recording -- is private by default rather than needing to
 * be remembered as another exclusion.
 */
export const SITE_PATHS = ['index.html', 'src', 'styles', 'presets'];

/**
 * Stage the site into `target`, replacing whatever was there.
 *
 * A missing entry throws rather than being skipped. Half a site is worse than no
 * site: it deploys, it loads, and it fails at whatever the absent file was needed
 * for -- which for `presets/` would be a fetch that 404s long after the deploy went
 * green.
 */
export async function stageSite(target) {
  const out = resolve(target);
  // The target is wiped before it is written, so a target that *contains* the repo
  // would delete the repo -- `stage-site.mjs .` or `stage-site.mjs ..`. `relative`
  // from the target to the root climbs (`..`) only when the root is not inside it,
  // which is the one case that is safe.
  const fromTarget = relative(out, resolve(ROOT));
  if (fromTarget === '' || !fromTarget.startsWith('..')) {
    throw new Error(`refusing to stage into ${out}: the repository lives inside it`);
  }

  for (const entry of SITE_PATHS) {
    const from = join(ROOT, entry);
    // Checked up front, so a missing path fails before anything has been written and
    // there is no partially-staged directory to mistake for a good one.
    try {
      await stat(from);
    } catch {
      throw new Error(`cannot stage the site: ${entry} does not exist`);
    }
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const entry of SITE_PATHS) {
    await cp(join(ROOT, entry), join(out, entry), { recursive: true });
  }
  return out;
}

// Only when run as a script -- the test imports the two exports above instead.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/stage-site.mjs <target-dir>');
    process.exit(1);
  }
  stageSite(target)
    .then((out) => console.log(`staged ${SITE_PATHS.join(', ')} into ${out}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
