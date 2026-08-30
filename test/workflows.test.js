import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The shape of the CI/CD workflows.
 *
 * A workflow file is the one kind of code in this repo that cannot be run locally and
 * whose mistakes surface late -- a release path defect waits for a release. Every
 * assertion here is a bug this repo has actually had:
 *
 *   - one commit starting four runs and ten jobs, because `push` and `pull_request`
 *     both fired and their concurrency groups differed;
 *   - a pre-release publishing to production (0.0.1 did);
 *   - `cancel-in-progress` on the deployment group, which can kill a publish
 *     half-written;
 *   - the "what ships" allow-list existing twice, so a preview and the live site could
 *     become different apps.
 *
 * js-yaml is not a dependency, and this repo has none. These tests skip themselves
 * when it is absent, so `npm test` stays green on a clean checkout -- and verify.yml
 * installs it ad hoc before running the suite, the same never-committed pattern the
 * typecheck and lint steps use, so in CI they really do run. Locally:
 * `npm install --no-save js-yaml`.
 */

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  yaml = null;
}

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const load = (file) => yaml.load(readFileSync(new URL(file, WORKFLOWS), 'utf8'));

/** `on:` parses as the boolean true in YAML 1.1, which is what js-yaml implements. */
const triggers = (wf) => wf.on ?? wf[true];

test('the workflow files are exactly the three that should exist', () => {
  // preview.yml was folded into ci.yml; a fourth file reappearing is the duplication
  // coming back.
  assert.deepEqual(readdirSync(WORKFLOWS).sort(), ['ci.yml', 'deploy.yml', 'verify.yml']);
});

test('CI runs on push alone, so one commit is one run', { skip: !yaml && 'js-yaml not installed' }, () => {
  const on = triggers(load('ci.yml'));
  assert.ok('push' in on, 'push is the trigger that covers every commit');
  assert.ok(!('pull_request' in on), 'pull_request would double every run on a PR branch');
  assert.ok('workflow_dispatch' in on, 'a manual re-run stays available');
});

test('CI verifies everything and previews everything but master', { skip: !yaml && 'js-yaml not installed' }, () => {
  const { jobs } = load('ci.yml');
  assert.deepEqual(Object.keys(jobs).sort(), ['preview', 'verify']);
  assert.equal(jobs.verify.uses, './.github/workflows/verify.yml', 'one definition of passing');
  assert.equal(jobs.preview.needs, 'verify', 'nothing is published before it is verified');
  assert.match(jobs.preview.if, /refs\/heads\/master/, 'master goes to production, not to the preview site');
});

test('a pre-release is verified but never published', { skip: !yaml && 'js-yaml not installed' }, () => {
  const { jobs } = load('deploy.yml');
  assert.match(jobs.build.if, /prerelease/, 'the guard 0.0.1 needed and did not have');
  // On build rather than on verify: a pre-release still has to pass.
  assert.equal(jobs.verify.if, undefined);
  assert.equal(jobs.resolve.if, undefined);
});

test('a deployment in flight is never cancelled', { skip: !yaml && 'js-yaml not installed' }, () => {
  const deploy = load('deploy.yml');
  assert.equal(deploy.concurrency.group, 'pages');
  assert.equal(deploy.concurrency['cancel-in-progress'], false, 'a half-written publish is worse than a slow one');
  // CI is the opposite case and should stay that way: superseded branch checks are
  // wasted work, not a broken site.
  assert.equal(load('ci.yml').concurrency['cancel-in-progress'], true);
});

test('everything in a deploy run agrees on which commit is being published', { skip: !yaml && 'js-yaml not installed' }, () => {
  const { jobs } = load('deploy.yml');
  const ref = '${{ needs.resolve.outputs.ref }}';
  assert.equal(jobs.verify.with.ref, ref, 'verify must check what is about to ship');
  assert.equal(jobs.build.steps[0].with.ref, ref, '...and build must ship what was checked');
  assert.ok(jobs.verify.needs.includes('resolve'));
  assert.ok(jobs.build.needs.includes('resolve'));
});

test('verify takes an optional ref, so its existing caller is unaffected', { skip: !yaml && 'js-yaml not installed' }, () => {
  const on = triggers(load('verify.yml'));
  assert.deepEqual(Object.keys(on), ['workflow_call'], 'it never runs on its own');
  const spec = on.workflow_call.inputs.ref;
  assert.equal(spec.required, false);
  assert.equal(spec.default, '', 'blank = whatever ref triggered the caller');
});

test('both deploys stage the site through the one script', { skip: !yaml && 'js-yaml not installed' }, () => {
  // The allow-list used to be four `cp` lines copied into both files. Two copies
  // drifting means the preview stops being a preview of what ships.
  const staging = (file, job) => load(file).jobs[job].steps
    .map((s) => s.run ?? '')
    .filter((run) => run.includes('stage-site'));

  for (const [file, job] of [['ci.yml', 'preview'], ['deploy.yml', 'build']]) {
    const steps = staging(file, job);
    assert.equal(steps.length, 1, `${file}:${job} must stage exactly once`);
    assert.match(steps[0], /node scripts\/stage-site\.mjs _site/);
  }

  // ...and nothing hand-rolls the copy any more.
  for (const file of ['ci.yml', 'deploy.yml']) {
    const text = readFileSync(new URL(file, WORKFLOWS), 'utf8');
    assert.ok(!/cp -r src styles presets/.test(text), `${file} still has an inline copy of the site list`);
  }
});

test('only the jobs that publish hold the permissions to publish', { skip: !yaml && 'js-yaml not installed' }, () => {
  const deploy = load('deploy.yml');
  assert.deepEqual(deploy.permissions, { contents: 'read' }, 'the root grants nothing extra');
  assert.equal(deploy.jobs.deploy.permissions['id-token'], 'write');
  assert.equal(deploy.jobs.deploy.permissions.pages, 'write');
  // resolve and verify never touch Pages.
  assert.equal(deploy.jobs.resolve.permissions, undefined);
  assert.equal(load('ci.yml').permissions.pages, undefined);
});
