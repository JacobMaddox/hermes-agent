#!/usr/bin/env node
// Headless screenshot capture.
//
// Drives the demo to a fixed set of camera positions and writes a PNG for
// each. The world seed is fixed, so two runs of this against the same commit
// produce byte-comparable images — which is what makes it useful for spotting
// a rendering regression rather than just admiring the view.
//
//   node tools/capture.mjs                        # all shots, ./captures
//   node tools/capture.mjs --quality ultra --out /tmp/shots
//   node tools/capture.mjs --only temple,market

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadPlaywright, launchOptions, CONTEXT_OPTIONS } from './_playwright.mjs';

const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL_BASE = arg('--url', 'http://127.0.0.1:8099/index.html');
const QUALITY = arg('--quality', 'high');
const OUT = arg('--out', 'captures');
const ONLY = arg('--only', null);
const WIDTH = parseInt(arg('--width', '1600'), 10);
const HEIGHT = parseInt(arg('--height', '900'), 10);
const SETTLE = parseInt(arg('--settle', '900'), 10);

// [name, x, y, z, yaw, pitch] — yaw 0 looks toward -Z, +yaw turns left.
// Positions are a little above the deck; the player settles onto it before the
// shot is taken. Chosen to frame architecture rather than to stand inside it.
const SHOTS = [
  ['01-landing-terrace', 0, 15.2, 97, 0, -0.04],
  ['02-landing-colonnade', -15, 15.2, 88, -0.55, 0.05],
  ['03-descent', 0, 15.2, 74, 0, -0.22],
  ['04-market-approach', 0, 7.2, 46, 0, -0.06],
  ['05-market-plaza', 0, 7.2, 30, 0, -0.08],
  ['06-market-street', -3, 7.2, 6, 3.0, 0.02],
  ['07-market-rooftop', -20, 13.0, 4, 0.35, -0.12],
  ['08-vault-stair', -30, 7.2, 16, 1.57, -0.30],
  ['09-vaults', -62, -6.8, 26, 0, 0.02],
  ['10-bridge-east', 30, 7.2, -8, -1.35, 0.0],
  ['11-ruins', 56, 11.2, -8, -1.0, 0.0],
  ['12-ruins-beacon', 66, 11.2, 0, -2.5, 0.03],
  ['13-pier', 44, 13.2, -50, 2.6, -0.06],
  ['14-great-span', 30, 13.2, -48, 2.3, 0.02],
  ['15-temple-approach', 0, 15.2, -32, 0, 0.14],
  ['16-temple-stair', 0, 15.2, -43, 0, 0.20],
  ['17-temple-dome', 0, 27.2, -57, 0, 0.16],
  ['18-temple-sanctum', 0, 27.2, -70, 0, 0.04],
  ['19-overlook', 22, 27.2, -64, -0.75, -0.20]
];

const shots = ONLY
  ? SHOTS.filter((s) => ONLY.split(',').some((k) => s[0].includes(k.trim())))
  : SHOTS;

await mkdir(OUT, { recursive: true });

const params = [`q=${QUALITY}`];
if (!args.includes('--cdn') && !URL_BASE.startsWith('file:')) params.push('three=local');
const url = `${URL_BASE}${URL_BASE.includes('?') ? '&' : '?'}${params.join('&')}`;

const browser = await chromium.launch(launchOptions({
  headless: true,
  proxy: args.includes('--cdn')
}));
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  ...CONTEXT_OPTIONS
});

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else if (m.text().startsWith('[aetherium]')) console.log(`  · ${m.text()}`);
});

console.log(`\nCapturing ${shots.length} shot(s) at ${WIDTH}x${HEIGHT}, preset ${QUALITY}`);
console.log(`  ${url} -> ${OUT}/\n`);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.AETHERIUM, null, { timeout: 180000 });

// Start the run so the HUD, weapon and drones are all present in frame.
await page.click('#startBtn');
await page.waitForTimeout(1200);

for (const [name, x, y, z, yaw, pitch] of shots) {
  await page.evaluate(([x, y, z, yaw, pitch]) => {
    const A = window.AETHERIUM;
    const p = A.ctx.get('player');
    p.respawn({ x, y, z, clone: () => ({ x, y, z }) });
    p.position.set(x, y, z);
    p.velocity.set(0, 0, 0);
    p.yaw = yaw;
    p.pitch = pitch;
    p.locked = true;
    // Freeze the AI so a drone does not wander into the middle of every shot.
    A.ctx.get('ai').actors.forEach((a) => { a.velocity.set(0, 0, 0); });
  }, [x, y, z, yaw, pitch]);

  // Wait for the player to actually land and for the shadow frustum to
  // re-snap. A fixed sleep is not enough on a software rasteriser running at
  // one or two frames a second: the shot lands mid-fall, looking at the
  // underside of the island, and the frame is dark because the shadow camera
  // is still centred where the player used to be.
  const settled = await page.waitForFunction(() => {
    const A = window.AETHERIUM;
    A.ctx.paused = false;
    const p = A.ctx.get('player');
    return p.grounded && Math.abs(p.velocity.y) < 0.01;
  }, null, { timeout: 60000, polling: 200 }).then(() => true).catch(() => false);

  if (!settled) console.warn(`  ! ${name}: player never settled; shot may be mid-air`);
  await page.waitForTimeout(SETTLE);

  // Generous timeout: on a software rasteriser the scene runs at a couple of
  // frames per second and the default 30s is not enough to land one.
  const buf = await page.screenshot({ type: 'png', timeout: 180000 });
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, buf);
  console.log(`  ✓ ${name}.png`);
}

const stats = await page.evaluate(() => window.AETHERIUM.stats());
console.log(`\n  ${stats.fps.toFixed(0)} fps · ${stats.drawCalls} draw calls · ` +
  `scale ${stats.renderScale.toFixed(2)} · ${stats.colliders} colliders`);

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} error(s) during capture:`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`\nWrote ${shots.length} capture(s) to ${OUT}/\n`);
