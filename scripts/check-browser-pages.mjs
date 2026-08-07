#!/usr/bin/env node
/**
 * Runs the 9 `test/browser/*-check.html` pages for real, in headless Chromium,
 * and fails the process if any of them doesn't finish cleanly.
 *
 * Each page is fully self-contained (its own inline `<script type="module">`, its
 * own `check()`/`failures` machinery -- there is no shared harness between them)
 * and signals completion the same way: it sets `document.title` to `'<name>-done'`
 * on success or `'<name>-failed'`/`'<name>-error'` on failure, after appending a
 * summary line to a `<pre id="log">`. This script polls for that title.
 *
 * `selftest.html` is deliberately excluded -- see its own header comment: offline
 * rendering can race the audio thread, so it is documented as unreliable evidence,
 * not a pass/fail gate, and `npm test` is what actually covers that ground.
 *
 * None of the 9 pages wrap their own script in try/catch or set a fallback
 * `<title>`, so an uncaught exception mid-script leaves the title at its default
 * (empty) forever -- a plain title-string wait would hang rather than fail. Every
 * wait here therefore has a timeout, and a timeout counts as a failure just like a
 * `-failed`/`-error` title would.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8123;
const TIMEOUT_MS = 15000;

/**
 * Explicit, not a glob -- keeps selftest.html's exclusion a deliberate, visible
 * decision in the script itself rather than an accident of a directory listing.
 */
const PAGES = [
  'euclid-view-check.html',
  'glide-control-check.html',
  'info-bar-check.html',
  'instrument-panel-check.html',
  'lfo-check.html',
  'mod-range-check.html',
  'percussion-render-check.html',
  'track-tabs-check.html',
  'trigger-controls-check.html',
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      let path = join(ROOT, decodeURIComponent(url.pathname));
      if (path.endsWith('/')) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    // Without this, a bound port (a stale process from a previous run that hasn't
    // released it yet) would leave this promise -- and the whole script -- hanging
    // forever instead of failing loudly.
    server.once('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

/** @returns {Promise<{ name: string, ok: boolean, detail: string }>} */
async function checkPage(browser, name) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  try {
    await page.goto(`http://localhost:${PORT}/test/browser/${name}`, { waitUntil: 'load', timeout: TIMEOUT_MS });
    // The pageFunction takes no argument, but `arg` still has to be passed
    // explicitly as `undefined` -- Playwright's overload resolution reads a bare
    // second parameter as `arg`, not `options`, so `waitForFunction(fn, { timeout })`
    // silently falls back to its own 30s default instead of honouring TIMEOUT_MS.
    await page.waitForFunction(
      () => /-(done|failed|error)$/.test(document.title),
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const title = await page.title();
    const ok = title.endsWith('-done');
    const logText = await page.locator('#log, #out').first().textContent().catch(() => '');
    const detail = ok
      ? title
      : `${title || '(title never set -- likely an uncaught exception)'}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}${logText ? `\n  last log: ...${logText.slice(-300)}` : ''}`;
    return { name, ok, detail };
  } catch (err) {
    const title = await page.title().catch(() => '');
    return {
      name,
      ok: false,
      detail: `timed out after ${TIMEOUT_MS}ms waiting for a -done/-failed/-error title (last title: "${title}")\n  ${err.message}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}`,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();

  const results = [];
  try {
    for (const name of PAGES) {
      // Sequential, not parallel: several pages assert on shared visual/geometry
      // state (canvas sizes, computed styles) that a busy machine running many
      // Chromium tabs at once could perturb -- these pages are quick, and this
      // keeps a failure's console output attributable to one page at a time.
      results.push(await checkPage(browser, name));
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
