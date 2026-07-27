// Playwright resolver.
//
// The capture and playtest tools need Playwright, but this demo deliberately
// has no package.json — it is a no-build project. So we resolve Playwright
// from wherever it happens to live: a local node_modules, a global npm root,
// or an explicit PLAYWRIGHT_PATH. If none is found we say so plainly rather
// than dying with a bare ERR_MODULE_NOT_FOUND.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function globalRoot() {
  try {
    return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

// Playwright ships as CommonJS. Importing it by file URL gives a namespace
// whose real exports hang off `.default`, while importing it by package name
// gets them hoisted — so normalise before handing it back.
function normalise(mod) {
  if (mod && typeof mod.chromium === 'object') return mod;
  if (mod && mod.default && typeof mod.default.chromium === 'object') return mod.default;
  return mod;
}

export async function loadPlaywright() {
  // 1. Normal resolution (local node_modules, or a hoisted workspace).
  try {
    return normalise(await import('playwright'));
  } catch (_) { /* keep looking */ }

  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  const g = globalRoot();
  if (g) candidates.push(path.join(g, 'playwright'));
  candidates.push('/opt/node22/lib/node_modules/playwright');
  candidates.push('/usr/lib/node_modules/playwright');
  candidates.push('/usr/local/lib/node_modules/playwright');

  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const entry = require.resolve(path.join(dir, 'index.js'));
      return normalise(await import(pathToFileURL(entry).href));
    } catch (_) { /* try the next one */ }
  }

  throw new Error(
    'Playwright not found. Install it (npm i -D playwright) or set ' +
    'PLAYWRIGHT_PATH to an existing installation. Chromium itself is already ' +
    'present in this environment at /opt/pw-browsers.'
  );
}

// Launch flags that get WebGL2 working in headless Chromium. Without the
// SwiftShader flags the context creation silently fails and every capture
// comes back black.
export const LAUNCH_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--no-sandbox'
];

// Chromium only needs an egress proxy when the demo is pulling Three.js from
// the CDN. With `three=local` (see tools/fetch-three.mjs) every request is to
// the loopback static server, and routing those through a proxy is not just
// unnecessary — some proxies answer plain-HTTP loopback requests with 405 and
// the page never loads at all. So the proxy is opt-in.
//
//   launchOptions({ proxy: true })   use HTTPS_PROXY / HTTP_PROXY if set
//   launchOptions()                  direct, loopback only
export function launchOptions(extra = {}) {
  const { proxy: wantProxy, ...rest } = extra;
  const opts = { args: [...LAUNCH_ARGS], ...rest };
  if (!wantProxy) return opts;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyUrl) {
    opts.proxy = { server: proxyUrl, bypass: 'localhost,127.0.0.1,::1,<-loopback>' };
  }
  return opts;
}

// A proxy that terminates TLS presents its own certificate, which Chromium has
// no reason to trust. Only relevant for these local tools, never for the demo
// itself.
export const CONTEXT_OPTIONS = {
  ignoreHTTPSErrors: true
};
