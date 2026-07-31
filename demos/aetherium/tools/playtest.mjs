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

// Lower than it looks: bridges and stairs now emit one ramp each instead of a
// box per segment, so the total dropped by roughly a third while covering the
// same geometry. This guards against the world failing to build at all.
if (boot.colliders < 240) fail(`only ${boot.colliders} colliders — world did not build`);
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
  // Let gravity seat the player rather than sampling mid-fall.
  await page.evaluate(() => window.AETHERIUM.step(0.8));
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

// Reload runs off per-frame update, so drive it with simulated time rather
// than wall-clock: at one frame a second a real-time wait would take a minute
// to cover a two-second reload.
const reloaded = await page.evaluate(() => {
  const A = window.AETHERIUM;
  A.ctx.paused = false;
  const w = A.ctx.get('weapons');
  w.startReload();
  for (let i = 0; i < 240; i++) {
    w.update(1 / 60);
    if (!w.reloading) break;
  }
  return w.ammo;
});
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

// ── Traversal: walk it, never jump ──────────────────────────────────────────
//
// This is the regression test for the bridge bug. The player is driven with
// real movement input and Space is never pressed, so if any span or stair
// needs a jump to cross, arrival simply never happens and the test fails.
console.log('\ntraversal (no jumping)');

async function walkTo(label, from, to) {
  // The whole walk happens inside one evaluate, stepping the simulation
  // directly. Polling the page from Node instead would be gated on the render
  // loop, which on a software rasteriser runs at about one frame a second —
  // the test would time out long before the player crossed anything, and it
  // would be measuring the rasteriser rather than the collision solver.
  const res = await page.evaluate(([f, t]) => {
    const A = window.AETHERIUM;
    A.ctx.paused = false;
    const p = A.ctx.get('player');

    p.respawn({ x: f[0], y: f[1], z: f[2] });
    p.position.set(f[0], f[1], f[2]);
    p.locked = true;
    for (const k in p.keys) p.keys[k] = false;

    // Let gravity seat the player on the deck before setting off.
    A.step(1.0);
    const landed = p.grounded;

    let best = Infinity;
    let stalled = 0;
    let arrived = false;
    const trace = [];

    for (let i = 0; i < 900; i++) {
      // Steer toward the target and hold forward. Space is never pressed, so
      // anything that needs a jump simply never gets crossed.
      p.yaw = Math.atan2(-(t[0] - p.position.x), -(t[2] - p.position.z));
      p.keys['KeyW'] = true;
      p.keys['Space'] = false;
      A.step(1 / 30);

      const d = Math.hypot(t[0] - p.position.x, t[2] - p.position.z);
      if (i % 60 === 0) trace.push(+d.toFixed(1));
      if (d < best - 0.05) { best = d; stalled = 0; } else stalled++;
      if (d < 3.0) { best = d; arrived = true; break; }
      if (p.dead || p.position.y < -60) break;
      // Two simulated seconds without gaining ground is a genuine stall.
      if (stalled > 60) break;
    }

    for (const k in p.keys) p.keys[k] = false;
    return {
      landed, arrived, best, trace,
      dead: p.dead, y: p.position.y, wall: p.moveState.hitWall
    };
  }, [from, to]);

  if (!res.landed) { fail(`${label}: start point is not over solid ground`); return; }
  if (res.dead) fail(`${label}: died en route`);
  else if (res.y < -60) fail(`${label}: fell off the route`);
  else if (res.arrived) pass(`${label} — walked it, no jumping`);
  else {
    fail(`${label}: stopped ${res.best.toFixed(1)}m short` +
      (res.wall ? ' against a wall' : '') + ` [${res.trace.join(' > ')}]`);
  }
}

// Each route starts on solid deck a few metres before a crossing and ends a
// few metres past it — just enough to prove the seam is walkable, without
// spending a minute per route at software-rasteriser frame rates. The two
// diagonal spans are the ones that were impassable.
// Routes line up with where each crossing actually attaches. The rim
// balustrades are load-bearing here: walking at the wrong offset runs into one
// and stops, which is correct behaviour and not what this test is measuring.
await walkTo('landing stair', [0, 14.4, 70], [0, 6.2, 55]);
// Aimed at the far end of the deck rather than a point beyond it: the walk is
// a straight line, and a target off the bridge axis steers the player into a
// parapet three quarters of the way across — which is the parapet doing its
// job, not a traversal failure.
await walkTo('market -> ruins bridge', [30, 7.2, 11], [51, 10.5, -6]);
await walkTo('ruins -> pier bridge', [53, 11.2, -35], [44, 13, -50]);
await walkTo('temple grand stair', [0, 14.4, -43], [0, 26.2, -61]);
await walkTo('vault descent stair', [-31, 6.4, 13.5], [-56, -6, 13.5]);

// ── ADS: is there actually a hole in the sight? ─────────────────────────────
console.log('\naim-down-sights');
const aperture = await page.evaluate(() => {
  const A = window.AETHERIUM;
  const THREE = A.THREE;
  const ctx = A.ctx;
  ctx.paused = false;
  const player = ctx.get('player');
  const weapons = ctx.get('weapons');

  // Force fully-aimed pose without waiting for the blend.
  player.locked = true;
  player.setAds(true);
  weapons._adsT = 1;
  weapons.update(0.016);
  ctx.camera.updateMatrixWorld(true);

  // Cast straight down the aim axis and collect anything opaque it hits on the
  // viewmodel layer. A working sight has a clear aperture; a solid plate does
  // not.
  const ray = new THREE.Raycaster();
  ray.layers.set(1);
  ray.near = 0.001;
  ray.far = 3;
  const dir = new THREE.Vector3();
  ctx.camera.getWorldDirection(dir);
  ray.set(ctx.camera.position, dir);

  const hits = ray.intersectObject(weapons.group, true);
  const opaque = hits.filter((h) => {
    const m = h.object.material;
    if (!m) return false;
    if (m.depthTest === false) return false;          // reticle overlay
    return !(m.transparent && m.opacity < 0.5);       // lens is see-through
  });
  return {
    blocked: opaque.length,
    firstBlocker: opaque.length ? opaque[0].object.material.name || 'unnamed' : null,
    apertureRadius: weapons.rig.apertureRadius
  };
});

if (aperture.blocked > 0) {
  fail(`sight line is blocked by ${aperture.blocked} opaque part(s) ` +
    `(first: ${aperture.firstBlocker}) — the optic has no aperture`);
} else {
  pass(`sight line is clear (aperture r=${aperture.apertureRadius})`);
}

await page.evaluate(() => {
  const ctx = window.AETHERIUM.ctx;
  ctx.get('player').setAds(false);
  ctx.get('weapons')._adsT = 0;
});

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
