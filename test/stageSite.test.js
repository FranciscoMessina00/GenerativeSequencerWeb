import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_PATHS, stageSite } from '../scripts/stage-site.mjs';

/** fileURLToPath, never `url.pathname`: the latter keeps the %20s and, on Windows,
 *  the leading slash -- so it yields a path that looks plausible and points nowhere. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * What ships.
 *
 * The list used to live twice, inline in two workflow files, where nothing could
 * check it and the two copies drifting would have meant the preview site and the
 * production site quietly becoming different apps. It lives once now, so it can be
 * tested -- and this is that test.
 */

async function inTemp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'stage-site-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the whole site lands, and nothing else does', async () => {
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    await stageSite(out);

    const staged = (await readdir(out)).sort();
    // Exactly the allow-list: an extra entry here means something reached the public
    // site without anyone deciding it should.
    assert.deepEqual(staged, [...SITE_PATHS].sort());
  });
});

test('directories are copied through, not just named', async () => {
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    await stageSite(out);

    // The three the app actually loads at runtime -- index.html's <script>, the
    // stylesheet, the worklets AudioEngine.addModule()s, and the patch fetch.
    assert.ok(existsSync(join(out, 'index.html')));
    assert.ok(existsSync(join(out, 'src', 'main.js')));
    assert.ok(existsSync(join(out, 'src', 'audio', 'worklets', 'modal-processor.js')));
    assert.ok(existsSync(join(out, 'styles', 'main.css')));
    assert.ok(existsSync(join(out, 'presets', 'factory.json')));
  });
});

test('files arrive unaltered -- this copies, it does not build', async () => {
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    await stageSite(out);

    const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const staged = await readFile(join(out, 'index.html'), 'utf8');
    assert.equal(staged, source);
  });
});

test('what the repo keeps to itself stays out', async () => {
  // The allow-list's whole point: these exist at the root and must never be served.
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    await stageSite(out);
    for (const private_ of ['test', 'scripts', 'docs', 'package.json', 'README.md', '.github']) {
      assert.equal(existsSync(join(out, private_)), false, `${private_} must not ship`);
    }
  });
});

test('staging twice leaves the same thing, not a merge of both', async () => {
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    await stageSite(out);
    await writeFile(join(out, 'left-over.txt'), 'from a previous run');
    await stageSite(out);

    assert.equal(existsSync(join(out, 'left-over.txt')), false, 'the target is replaced, not added to');
    assert.deepEqual((await readdir(out)).sort(), [...SITE_PATHS].sort());
  });
});

test('it refuses to stage over the repository, or anything containing it', async () => {
  // The target is wiped before it is written, so `stage-site.mjs .` would delete the
  // repo and `stage-site.mjs ..` would delete whatever else lives beside it.
  await assert.rejects(() => stageSite(REPO_ROOT), /refusing/);
  await assert.rejects(() => stageSite(join(REPO_ROOT, '.')), /refusing/);
  await assert.rejects(() => stageSite(dirname(REPO_ROOT)), /refusing/);
});

test('a target below the repo is fine -- that is the normal case', async () => {
  // `_site` is exactly what both workflows pass.
  await inTemp(async (dir) => {
    const out = join(dir, '_site');
    assert.equal(await stageSite(out), out);
  });
});

test('every path on the list exists, or the deploy would ship half a site', async () => {
  // The failure this guards is silent otherwise: a renamed directory deploys green
  // and 404s at runtime, on whatever the missing file was needed for.
  for (const entry of SITE_PATHS) {
    assert.ok(
      existsSync(new URL(`../${entry}`, import.meta.url)),
      `${entry} is on the site list but not in the repo`,
    );
  }
});
