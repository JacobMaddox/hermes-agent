#!/usr/bin/env node
// Populate ./vendor with a local copy of Three.js.
//
// The demo loads Three.js from a CDN by default, which is fine on a normal
// network but useless offline, in CI, or behind an egress policy that does not
// allow the CDN host. This pulls the same pinned version from the npm registry
// into ./vendor, after which:
//
//   index.html?three=local     runs the source tree with no external requests
//   node tools/bundle.mjs --vendor   inlines it into the single-file build
//
// ./vendor is gitignored — it is a reproducible fetch, not a checked-in copy.

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.argv[2] || '0.180.0';
const VENDOR = path.join(ROOT, 'vendor');

// Everything the demo imports, plus GTAOPass which is loaded dynamically.
const ENTRIES = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/SMAAPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/GTAOPass.js',
  'objects/Sky.js',
  'utils/BufferGeometryUtils.js'
];

const tmp = mkdtempSync(path.join(tmpdir(), 'three-vendor-'));
try {
  console.log(`fetching three@${VERSION} from the npm registry...`);
  const out = execFileSync('npm', ['pack', `three@${VERSION}`, '--pack-destination', tmp, '--silent'],
    { encoding: 'utf8' }).trim().split('\n').pop();
  const tgz = path.join(tmp, out);
  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  const pkg = path.join(tmp, 'package');

  mkdirSync(path.join(VENDOR, 'build'), { recursive: true });

  // The r18x build is split: three.module.js imports three.core.js beside it,
  // so both have to come across or the relative import 404s.
  //
  // We take the minified pair — 0.7MB against 2.0MB — because these files end
  // up embedded verbatim in the committed single-file build, and a 2.7MB HTML
  // artifact is not a reasonable thing to put in a repository. They are copied
  // under the unminified names so nothing downstream has to care which variant
  // is present; the one import inside is rewritten to match.
  const core = readFileSync(path.join(pkg, 'build', 'three.core.min.js'), 'utf8');
  const mod = readFileSync(path.join(pkg, 'build', 'three.module.min.js'), 'utf8')
    .split('./three.core.min.js').join('./three.core.js');
  writeFileSync(path.join(VENDOR, 'build', 'three.core.js'), core);
  writeFileSync(path.join(VENDOR, 'build', 'three.module.js'), mod);

  // Walk each addon's relative imports so we bring the whole closure, not just
  // the files we name.
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = path.join(pkg, 'examples', 'jsm', rel);
    if (!existsSync(src)) {
      console.warn(`  ! missing ${rel}`);
      return;
    }
    const dst = path.join(VENDOR, 'addons', rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);

    const code = readFileSync(src, 'utf8');
    const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?['"](\.[^'"\n]+)['"]/g;
    let m;
    while ((m = re.exec(code))) {
      walk(path.normalize(path.join(path.dirname(rel), m[1])));
    }
  };
  for (const e of ENTRIES) walk(e);

  console.log(`  vendored 2 build files + ${seen.size} addon modules -> vendor/`);
  console.log('\nNow you can run:');
  console.log('  index.html?three=local          (source tree, no external requests)');
  console.log('  node tools/bundle.mjs --vendor  (fully self-contained single file)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
