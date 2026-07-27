#!/usr/bin/env node
// Scripted smoke test.
//
// Boots the demo in headless Chromium, starts the run, drives the player
// through every district, fires, and asserts that nothing threw and nothing
// went NaN. Run against either build:
//
//   node tools/playtest.mjs                     # source tree on :8099
//   node tools/playtest.mjs --url file://...    # the single-file bundle
//
// Chromium is preinstalled at /opt/pw-browsers in this environment; if
// Playwright is installed globally, point NODE_PATH at it.

import { loadPlaywright, launchOptions, CONTEXT_OPTIONS } from './_playwright.mjs';

const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL_BASE = arg('--url', 'http://127.0.0.1:8099/index.html');
const QUALITY = arg('--quality', 'medium');
const HEADFUL = args.includes('--headful');
// Prefer the vendored Three.js when one has been fetched: it makes the run
// independent of CDN reachability, which matters in CI and behind egress
// policies. Pass --cdn to exercise the default path instead.
const LOCAL_THREE = !args.includes('--cdn');

const params = [`q=${QUALITY}`];
if (LOCAL_THREE && !URL_BASE.startsWith('file:')) params.push('three=local');
const url = `${URL_BASE}${URL_BASE.includes('?') ? '&' : '?'}${params.join('&')}`;

const errors = [];
const warnings = [];

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  errors.push(msg);
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

const browser = await chromium.launch(launchOptions({
  headless: !HEADFUL,
  proxy: !LOCAL_THREE
}));

const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  ...CONTEXT_OPTIONS
});

page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error') errors.push(`console.error: ${text}`);
  else if (t === 'warning') warnings.push(text);
  else if (text.startsWith('[aetherium]') || text.startsWith('[ai]')) console.log(`  · ${text}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
});

console.log(`\nAetherium playtest — ${url}\n`);
console.log('boot');

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

try {
  await page.waitForFunction(() => !!window.AETHERIUM, null, { timeout: 120000 });
  pass(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  const label = await page.textContent('#loadLabel').catch(() => '(none)');
  fail(`never booted — loader said: ${label}`);
  console.error('\nErrors:\n' + errors.map((e) => '  ' + e).join('\n'));
  await browser.close();
  process.exit(1);
}

const boot = await page.evaluate(() => window.AETHERIUM.stats());
console.log(`  · preset=${await page.evaluate(() => window.AETHERIUM.quality)} ` +
  `colliders=${boot.colliders} navCells=${boot.navCells}`);

if (boot.colliders < 400) fail(`only ${boot.colliders} colliders — world did not build`);
else pass(`world built (${boot.colliders} colliders)`);

if (boot.navCells < 2000) fail(`only ${boot.navCells} nav cells — navigation grid is too sparse`);
else pass(`navigation grid baked (${boot.navCells} walkable cells)`);

console.log('\nstart run');
await page.click('#startBtn');
// Headless Chromium refuses pointer lock, and the demo correctly treats a lost
// lock as a pause. Force the simulation back on so the rest of the run
// exercises real per-frame code rather than a paused loop.
await page.evaluate(() => {
  window.AETHERIUM.ctx.paused = false;
  window.AETHERIUM.ctx.get('player').locked = true;
});
await page.waitForTimeout(1200);

const started = await page.evaluate(() => window.AETHERIUM.stats());
if (!started.stage) fail('campaign did not start');
else pass(`stage "${started.stage}" active`);

// Drive: look around, move, jump, fire, reload. Pointer lock will not engage
// in headless, so movement is exercised by teleporting between districts and
// letting a frame of simulation run at each stop.
console.log('\ntraverse');
const stops = [
  ['landing', 0, 16.5, 96],
  ['market', 0, 8, 40],
  ['market centre', 0, 8, 16],
  ['vault stair', -36, 8, 16],
  ['vaults', -62, -6, 16],
  ['ruins bridge', 42, 8, -6],
  ['ruins', 78, 12, -20],
  ['pier', 41, 14, -55],
  ['temple apron', 0, 16, -36],
  ['grand stair', 0, 20, -52],
  ['temple', 0, 28, -82]
];

for (const [label, x, y, z] of stops) {
  await page.evaluate(([x, y, z]) => {
    window.AETHERIUM.ctx.paused = false;
    window.AETHERIUM.teleport(x, y, z);
  }, [x, y, z]);
  await page.waitForTimeout(320);
  const s = await page.evaluate(() => window.AETHERIUM.stats());
  const bad = s.playerPos.some((v) => !isFinite(v));
  if (bad) fail(`${label}: player position went non-finite (${s.playerPos})`);
  else if (s.playerPos[1] < -60) fail(`${label}: player fell out of the world (y=${s.playerPos[1]})`);
  else pass(`${label} → y=${s.playerPos[1].toFixed(2)} hp=${Math.round(s.hp)}`);
}

console.log('\nweapon');
await page.evaluate(() => window.AETHERIUM.teleport(0, 16.5, 96));
await page.waitForTimeout(300);

const ammoBefore = await page.evaluate(() => window.AETHERIUM.stats().ammo);
await page.evaluate(() => {
  const w = window.AETHERIUM.ctx.get('weapons');
  const p = window.AETHERIUM.ctx.get('player');
  p.locked = true;
  window.AETHERIUM.ctx.paused = false;
  for (let i = 0; i < 8; i++) { w._cooldown = 0; w.fire(); }
});
await page.waitForTimeout(200);
const ammoAfter = await page.evaluate(() => window.AETHERIUM.stats().ammo);
if (ammoAfter >= ammoBefore) fail(`firing did not consume ammo (${ammoBefore} -> ${ammoAfter})`);
else pass(`fired 8 rounds (${ammoBefore} -> ${ammoAfter})`);

await page.evaluate(() => {
  window.AETHERIUM.ctx.paused = false;
  window.AETHERIUM.ctx.get('weapons').startReload();
});
// Poll rather than sleep a fixed interval: the loop clamps per-frame delta to
// 250ms, so on a software rasteriser at 3fps simulated time runs far behind
// wall-clock and a fixed wait would fail for reasons that have nothing to do
// with the reload logic.
let reloaded = 0;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  reloaded = await page.evaluate(() => {
    window.AETHERIUM.ctx.paused = false;
    return window.AETHERIUM.stats().ammo;
  });
  if (reloaded === 30) break;
}
if (reloaded !== 30) fail(`reload did not refill the magazine (got ${reloaded})`);
else pass('reload refilled the magazine');

console.log('\ncombat');
await page.evaluate(() => {
  const ai = window.AETHERIUM.ctx.get('ai');
  const THREE = window.AETHERIUM.ctx.camera.constructor;
  if (ai.actors.length) {
    const a = ai.actors.find((x) => x.alive);
    if (a) ai.damageActor(a, 9999, a.position.clone(), true, { x: 0, y: 0, z: 1 });
  }
});
await page.waitForTimeout(600);
const kills = await page.evaluate(() => window.AETHERIUM.ctx.get('player').stats.kills);
if (kills < 1) fail('killing an actor did not register');
else pass(`kill registered (${kills})`);

console.log('\nperformance');
await page.waitForTimeout(2500);
const perf = await page.evaluate(() => window.AETHERIUM.stats());
console.log(`  · ${perf.fps.toFixed(0)} fps · ${perf.frameMs.toFixed(1)}ms avg · ` +
  `p95 ${perf.p95.toFixed(1)}ms · ${perf.drawCalls} draws · scale ${perf.renderScale.toFixed(2)}`);
// Healthy is ~140-260 depending on where you stand: eight merged world
// batches, ~4 meshes per drone, 10 for the viewmodel, plus the shadow pass and
// ~25 post-processing quads. If world or drone merging silently fails this
// jumps past 500, which is what this guards against — it is a regression
// tripwire, not a tight budget.
if (perf.drawCalls > 340) fail(`${perf.drawCalls} draw calls — batching regressed`);
else pass(`${perf.drawCalls} draw calls`);

await browser.close();

console.log('');
if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of [...new Set(warnings)].slice(0, 8)) console.log(`  ! ${w}`);
  console.log('');
}

if (errors.length) {
  console.error(`FAILED — ${errors.length} problem(s):`);
  for (const e of [...new Set(errors)]) console.error(`  ✗ ${e}`);
  process.exit(1);
}

console.log('PASSED — no console errors, no failed requests.\n');
