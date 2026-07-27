#!/usr/bin/env node
// Single-file bundler.
//
// The source tree is native ES modules, which browsers refuse to load over
// file:// — so out of the box you need a static server. This flattens every
// module and the stylesheet into one self-contained dist/index.html that you
// can double-click, email, or paste onto any host.
//
//   node tools/bundle.mjs                 # Three.js still from the CDN
//   node tools/bundle.mjs --vendor        # Three.js inlined too: fully offline
//
// Each module is wrapped in an IIFE and registered in a tiny runtime map, so
// module scope is preserved and two modules declaring the same top-level name
// cannot collide the way naive concatenation would let them.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/main.js';
const VENDOR = process.argv.includes('--vendor');
const OUT = path.join(ROOT, 'dist', 'index.html');
const THREE_VERSION = '0.180.0';
const CDN = `https://unpkg.com/three@${THREE_VERSION}`;

// Bare specifiers we do not own. Left as real imports so the browser's import
// map resolves them, unless --vendor inlines them.
const EXTERNAL = /^three(\/|$)/;

// ── Module graph ──────────────────────────────────────────────────────────

const modules = new Map();   // resolved path -> { code, deps, exports }
const order = [];

const IMPORT_RE =
  /^[ \t]*import\s+(?:([\w$]+)\s*,\s*)?(?:(\*\s+as\s+[\w$]+)|(\{[^}]*\})|([\w$]+))?\s*(?:from\s*)?['"]([^'"]+)['"];?[ \t]*$/gm;

function resolve(from, spec) {
  if (EXTERNAL.test(spec)) return spec;
  return path.normalize(path.join(path.dirname(from), spec));
}

async function load(rel) {
  if (modules.has(rel)) return;
  modules.set(rel, null); // cycle guard

  const code = await readFile(path.join(ROOT, rel), 'utf8');
  const deps = [];
  let body = code.replace(IMPORT_RE, (m, dflt, star, named, single, spec) => {
    const target = resolve(rel, spec);
    if (EXTERNAL.test(target)) return m; // keep as-is; hoisted later
    deps.push({ spec: target, dflt, star, named, single });
    return ''; // replaced by a binding prelude below
  });

  for (const d of deps) await load(d.spec);

  const exports = [];
  // `export class Foo` / `export function foo` / `export const foo`
  body = body.replace(/^[ \t]*export\s+(default\s+)?(class|function|const|let|var)\s+([\w$]+)/gm,
    (m, isDefault, kind, name) => {
      exports.push([name, name]);
      return m.replace(/^([ \t]*)export\s+(default\s+)?/, '$1');
    });
  // `export { A, B as C }`
  body = body.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (m, list) => {
    for (const part of list.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const [local, , alias] = t.split(/\s+/);
      exports.push([alias || local, local]);
    }
    return '';
  });

  const prelude = deps.map((d) => {
    const src = `__aeth(${JSON.stringify(d.spec)})`;
    const lines = [];
    if (d.star) lines.push(`const ${d.star.replace(/\*\s+as\s+/, '')} = ${src};`);
    if (d.named) lines.push(`const ${d.named.replace(/\s+as\s+/g, ': ')} = ${src};`);
    if (d.dflt) lines.push(`const ${d.dflt} = ${src}.default;`);
    if (d.single) lines.push(`const ${d.single} = ${src}.default;`);
    return lines.join('\n');
  }).filter(Boolean).join('\n');

  const returns = exports.length
    ? `return { ${exports.map(([a, l]) => (a === l ? a : `${a}: ${l}`)).join(', ')} };`
    : 'return {};';

  modules.set(rel, { prelude, body, returns });
  order.push(rel);
}

await load(ENTRY);

// ── External imports, hoisted ─────────────────────────────────────────────

const externals = new Map(); // spec -> namespace identifier
let extCounter = 0;
for (const [rel, mod] of modules) {
  if (!mod) continue;
  const code = await readFile(path.join(ROOT, rel), 'utf8');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(code))) {
    const spec = m[5];
    if (!EXTERNAL.test(spec)) continue;
    if (!externals.has(spec)) externals.set(spec, `__ext${extCounter++}`);
  }
}

// Rewrite each module's kept external imports into references to the hoisted
// namespaces, so the whole bundle has exactly one import per external module.
for (const [rel, mod] of modules) {
  if (!mod) continue;
  const lines = [];
  const code = await readFile(path.join(ROOT, rel), 'utf8');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(code))) {
    const [, dflt, star, named, single, spec] = m;
    if (!EXTERNAL.test(spec)) continue;
    const ns = externals.get(spec);
    if (star) lines.push(`const ${star.replace(/\*\s+as\s+/, '')} = ${ns};`);
    if (named) lines.push(`const ${named.replace(/\s+as\s+/g, ': ')} = ${ns};`);
    if (dflt) lines.push(`const ${dflt} = ${ns}.default ?? ${ns};`);
    if (single) lines.push(`const ${single} = ${ns}.default ?? ${ns};`);
  }
  mod.body = mod.body.replace(IMPORT_RE, '');
  mod.prelude = [lines.join('\n'), mod.prelude].filter(Boolean).join('\n');
}

// ── Vendoring ─────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';

const VENDOR_DIR = path.join(ROOT, 'vendor');
const HAS_VENDOR = existsSync(path.join(VENDOR_DIR, 'build', 'three.module.js'));

// Prefer the locally vendored copy (tools/fetch-three.mjs) and fall back to the
// CDN. curl rather than fetch for the remote case: it honours the environment's
// proxy and CA bundle without pulling in an HTTP-agent dependency.
function fetchText(url) {
  return execFileSync('curl', ['-fsSL', url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
}

// Keys mirror the vendored layout exactly (build/…, addons/…), so this is a
// straight path join.
function readVendored(key) {
  return readFileSync(path.join(VENDOR_DIR, key), 'utf8');
}

let vendorBlock = '';
if (VENDOR) {
  console.log(HAS_VENDOR
    ? `vendoring three@${THREE_VERSION} from ./vendor`
    : `vendoring three@${THREE_VERSION} from ${CDN} ` +
      `(run tools/fetch-three.mjs first to avoid the network)`);
  const files = new Map();   // key -> source
  const deps = new Map();    // key -> { specifier: key }
  const seq = [];

  // Keys are paths relative to the package layout mirrored in ./vendor, so
  // relative imports resolve with plain path arithmetic. This matters for the
  // r18x split build: three.module.js imports ./three.core.js beside it, and a
  // flat "three" key would resolve that sibling into the addons tree.
  const THREE_KEY = 'build/three.module.js';

  const keyFor = (spec) => spec === 'three'
    ? THREE_KEY
    : spec.replace(/^three\/addons\//, 'addons/');

  const urlFor = (key) => key.startsWith('build/')
    ? `${CDN}/${key}`
    : `${CDN}/examples/jsm/${key.replace(/^addons\//, '')}`;

  const sourceOf = (key) => HAS_VENDOR ? readVendored(key) : fetchText(urlFor(key));

  const walk = (key) => {
    if (files.has(key)) return;
    files.set(key, null);
    const src = sourceOf(key);
    files.set(key, src);

    const d = {};
    const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?['"]([^'"\n]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      let child;
      if (spec === 'three') child = THREE_KEY;
      else if (spec.startsWith('three/addons/')) child = keyFor(spec);
      else if (spec.startsWith('.')) {
        child = path.posix.normalize(path.posix.join(path.posix.dirname(key), spec));
      } else continue;
      d[spec] = child;
      walk(child);
    }
    deps.set(key, d);
    seq.push(key);
  };

  // Everything this demo touches, plus GTAOPass which is loaded dynamically.
  const entries = [
    THREE_KEY,
    'addons/postprocessing/EffectComposer.js',
    'addons/postprocessing/RenderPass.js',
    'addons/postprocessing/UnrealBloomPass.js',
    'addons/postprocessing/ShaderPass.js',
    'addons/postprocessing/SMAAPass.js',
    'addons/postprocessing/OutputPass.js',
    'addons/postprocessing/GTAOPass.js',
    'addons/objects/Sky.js',
    'addons/utils/BufferGeometryUtils.js'
  ];
  for (const e of entries) walk(e);

  const publicKeys = entries.map((k) =>
    [k === THREE_KEY ? 'three' : `three/addons/${k.replace(/^addons\//, '')}`, k]);

  vendorBlock = `<script>
// Three.js, inlined. Each module becomes a blob URL, its own import
// specifiers rewritten to point at the blobs of its dependencies, and the
// whole set is registered in an import map injected before any module runs.
// This is what makes the single-file build work with no network at all.
(function () {
  var SRC = ${JSON.stringify(Object.fromEntries(files))};
  var DEPS = ${JSON.stringify(Object.fromEntries(deps))};
  var ORDER = ${JSON.stringify(seq)};
  var PUBLIC = ${JSON.stringify(publicKeys)};
  var urls = {};
  for (var i = 0; i < ORDER.length; i++) {
    var key = ORDER[i];
    var src = SRC[key];
    var d = DEPS[key] || {};
    for (var spec in d) {
      var target = urls[d[spec]];
      if (!target) continue;
      src = src.split("'" + spec + "'").join("'" + target + "'")
               .split('"' + spec + '"').join('"' + target + '"');
    }
    urls[key] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  var imports = {};
  for (var j = 0; j < PUBLIC.length; j++) imports[PUBLIC[j][0]] = urls[PUBLIC[j][1]];
  var el = document.createElement('script');
  el.type = 'importmap';
  el.textContent = JSON.stringify({ imports: imports });
  document.head.appendChild(el);
})();
</script>`;
  console.log(`  inlined ${files.size} modules`);
}

// ── Assemble ──────────────────────────────────────────────────────────────

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const css = await readFile(path.join(ROOT, 'styles.css'), 'utf8');

const runtime = `
// Generated by tools/bundle.mjs — do not edit. Edit demos/aetherium/src and
// re-run the bundler.
${[...externals].map(([spec, ns]) => `import * as ${ns} from ${JSON.stringify(spec)};`).join('\n')}

const __aethModules = {};
const __aethCache = {};
function __aeth(id) {
  if (__aethCache[id]) return __aethCache[id];
  const f = __aethModules[id];
  if (!f) throw new Error('module not bundled: ' + id);
  return (__aethCache[id] = f());
}

${order.map((rel) => {
  const m = modules.get(rel);
  return `__aethModules[${JSON.stringify(rel)}] = function () {
${m.prelude}
${m.body}
${m.returns}
};`;
}).join('\n\n')}

__aeth(${JSON.stringify(ENTRY)});
`;

// Each substitution is checked. A silent miss here produces an HTML file that
// looks plausible and is completely broken — which is exactly what happened
// the first time the import-map injector was reworked and the bundler kept
// matching the markup it used to have.
function substitute(source, pattern, replacement, what) {
  if (!pattern.test(source)) {
    throw new Error(
      `bundle: could not find ${what} in index.html. The bundler and the ` +
      `markup have drifted apart — update the pattern in tools/bundle.mjs.`
    );
  }
  return source.replace(pattern, () => replacement);
}

let out = html;
out = substitute(out, /<link rel="stylesheet" href="styles\.css"\s*\/?>/,
  `<style>\n${css}\n</style>`, 'the stylesheet link');
out = substitute(out, /<script type="module" src="\.\/src\/main\.js"><\/script>/,
  `<script type="module">\n${runtime}\n</script>`, 'the entry module script');

if (VENDOR) {
  // Swap the import-map injector for one that points at inlined blob URLs.
  out = substitute(out, /<script id="importmap-boot">[\s\S]*?<\/script>/,
    vendorBlock, 'the import-map injector');
}

// A note in the source so nobody edits the generated file by mistake.
out = out.replace('<head>', `<head>
  <!-- GENERATED FILE — built by demos/aetherium/tools/bundle.mjs.
       Edit demos/aetherium/src/** and re-run the bundler instead.
       Three.js: ${VENDOR ? 'inlined (works fully offline)' : `from unpkg @ ${THREE_VERSION}`} -->`);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, out, 'utf8');

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0);
console.log(`\nBundled ${order.length} modules -> dist/index.html (${kb} KB)`);
console.log(VENDOR
  ? '  fully self-contained: open it straight off disk, no network needed'
  : '  open it straight off disk; Three.js loads from unpkg on first run');
