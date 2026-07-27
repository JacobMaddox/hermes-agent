# Aetherium Odyssey — Elysium Prime

A browser first-person shooter built on Three.js r180 and WebGL2. Every texture,
mesh, animation and sound is generated procedurally at load time — the only
thing that comes over the wire is the engine itself.

This is round 2 of the demo. Round 1 was a single 985-line `index.html`: a
working pointer-lock FPS with two patrolling drones on a ~50m terrace, but with
no textures, no environment map, no anti-aliasing, no wall collision and no
line-of-sight. This rebuilds it as a subsystem-partitioned engine over a
~190 × 210m sky archipelago with a four-stage campaign.

---

## Running it

The source tree is native ES modules, which browsers will not load over
`file://`. Serve the directory:

```sh
cd demos/aetherium
python3 -m http.server 8099
# then open http://localhost:8099
```

**Or just open `dist/index.html`** — that is the single-file build with every
module, the stylesheet and Three.js itself inlined (~1.3 MB). Double-click it,
email it, drop it on any static host. No server, no network, no install.

### URL parameters

| Parameter | Effect |
|---|---|
| `?q=low\|medium\|high\|ultra` | Force a quality preset instead of auto-detecting |
| `?seed=12345` | Reseed world generation, patrol routes and texture grain |
| `?three=local` | Load Three.js from `./vendor` instead of the CDN (see below) |

### Controls

| | |
|---|---|
| `W` `A` `S` `D` | Move |
| Mouse | Look · `LMB` fire · `RMB` aim down sights |
| `Shift` | Sprint |
| `Ctrl` / `C` | Crouch — at speed this becomes a slide |
| `Space` | Jump; hold into a ledge to mantle |
| `R` | Reload |
| `Q` `E` | Lean |
| `F1` | Performance overlay |
| `Esc` | Pause |

---

## The mission

Five islands over a cloud sea. The layout is deliberately 2.5D — no walkable
surface sits directly above another — which is what lets the navigation grid
stay two-dimensional without the AI ever pathing through a floor.

| District | Size | Role |
|---|---|---|
| Landing Terrace | 40 × 30 m | Spawn. Colonnade, moored skiff, opening patrol. |
| Market Tier | 68 × 64 m | Street grid, enterable buildings, rooftops, stalls. The close-quarters fight. |
| Sunken Vaults | 36 × 34 m | Enclosed hall lit only by aether pools. The contrast beat. |
| Ruined District | 56 × 50 m | Collapsed peristyle, rubble cover, the three beacons. |
| Temple Plateau | 56 × 52 m | Gold dome, cella, the finale. |

Linked by a ceremonial stair, an arched bridge, a long descending flight out
over the void, and the great span — which starts folded down against its pier
and swings into place when the beacons fall.

Four stages: **Secure the Landing** → **Cross the Market Tier** → **Restore the
Great Span** → **Take the Temple**.

Three enemy archetypes, distinguishable by silhouette alone at range:
**Skirmisher** (fast, flanks), **Sentry** (slow, accurate, long reach),
**Heavy** (bulky, high HP, suppressive).

---

## Architecture

Twelve subsystems under `src/`, each owning one directory. They never import
one another — everything resolves at runtime through the context
(`ctx.get('fx')`), which keeps the dependency graph acyclic.

```
src/
  core/       Context (service locator), event bus, seeded RNG + noise,
              fixed-step loop, quality presets, preallocated scratch
  render/     Renderer, composer chain, follow-frustum shadows, colour grade
  materials/  Procedural PBR bakery — 14 surfaces, albedo/normal/ORM
  sky/        Rayleigh/Mie atmosphere, cloud sea, PMREM environment probe
  world/      Archipelago builder, modular kit, collider bake, batching
  physics/    Spatial-hash broadphase, capsule solver, raycasts, debris
  player/     Movement state machine, camera dynamics, health
  weapons/    Procedural rifle, viewmodel rig, hitscan ballistics, recoil
  fx/         GPU particles, decals, tracers, muzzle flash, explosions
  ai/         Navigation grid + A*, perception, cover, alert states
  ui/         HUD, minimap, kill feed, menus, campaign director
  audio/      Spatial panner graph, synthesised reverb, occlusion
```

Three rules carried over from the reference architecture, because they are what
keep the thing maintainable:

- **No cross-subsystem imports.** Resolve at runtime.
- **No `Math.random()` in gameplay or visuals.** Everything draws from
  `ctx.rng`, so a given seed always produces the same world — which is what
  makes the screenshot tooling able to diff anything at all.
- **No per-frame allocation.** Scratch vectors and matrices are preallocated
  once; a new `Vector3` per drone per frame is what turns a flat 60 into a
  sawtooth.

Simulation runs at a fixed 120 Hz with a clamped accumulator; rendering runs at
whatever the display gives you.

Every smoothed value — camera roll, head bob, weapon sway, recoil recovery, FOV,
drone banking — uses `damp()` from `core/rng.js` rather than
`lerp(current, target, dt * rate)`. The naive form is fine at 60fps and
catastrophic on a stutter: once a frame exceeds `1/rate` seconds the interpolant
passes 1 and the value overshoots the target, which shows up as the camera
snapping to a wild angle. `1 - exp(-rate * dt)` is the same curve and cannot
overshoot.

### What changed from round 1, and why

The visual gap was not a polish problem. Four things were structural:

1. **Anti-aliasing was silently disabled.** `antialias: true` was set on the
   renderer, but every frame went through an `EffectComposer` whose render
   target was not multisampled, so it never applied. Every edge in the scene was
   hard-aliased — the single biggest reason it read as "blocky." The composer
   target now carries hardware MSAA (2–8× by preset) plus an SMAA pass.
2. **There were no textures.** Every material was a flat colour. There are now
   14 procedurally-baked surfaces with albedo, a Sobel-derived normal map, and
   packed AO + roughness, all tiling seamlessly and UV-scaled to world metres.
3. **There was no environment map.** `envMapIntensity` was set but nothing was
   ever generated, so `metalness: 0.95` gold had nothing to reflect and rendered
   as flat brown. The sky is now baked into a PMREM probe and handed to every
   material.
4. **The sky was a solid colour** with a mismatched fog colour, seaming at the
   horizon. It is now physical Rayleigh/Mie scattering, with the fog colour
   sampled out of the rendered sky so it cannot seam.

Gameplay had its own list: no wall collision at all, no line-of-sight checks (so
drones shot through walls), instant-velocity movement, projectile weapons with
single-point hitboxes, and death debris that was secretly enemy projectiles with
no gravity. All rebuilt.

---

## Tooling

No build step is required to run or develop the demo. The tools are optional and
need Playwright available (Chromium itself is usually already present).

```sh
# Fully self-contained single file -> dist/index.html
node tools/bundle.mjs --vendor

# Same, but Three.js still loads from the CDN (smaller output)
node tools/bundle.mjs

# Scripted smoke test: boot, traverse all five districts, fire, reload, kill
node tools/playtest.mjs
node tools/playtest.mjs --url file:///abs/path/to/dist/index.html

# Fixed-camera screenshots for reviewing rendering changes
node tools/capture.mjs --quality ultra --out captures

# Pull Three.js into ./vendor so everything works with no network
node tools/fetch-three.mjs
```

`vendor/` and `captures/` are gitignored. `dist/index.html` is committed — it is
the shareable deliverable, and it is verified the same way the source tree is:

```sh
node tools/playtest.mjs --url file:///abs/path/to/dist/index.html
```

`fetch-three.mjs` vendors the *minified* Three.js build under the unminified
filenames, because those bytes end up embedded verbatim in the committed
single-file artifact and the unminified pair would make it 2.7 MB. If you want
to debug inside Three.js, use the default CDN path, which serves the readable
build.

### Quality presets

Auto-detected on first load from the GL renderer string, core count and memory,
and overridable from the pause menu or `?q=`. Presets gate MSAA sample count,
shadow map size and extent, screen-space AO, bloom, particle/decal/debris
budgets, texture resolution, cloud layers, prop density and the point-light pool
size. Dynamic resolution scaling holds the frame budget on top of that.

Point lights are pooled at a **fixed count** and moved to the nearest authored
sources rather than being added and removed. Three keys shader permutations on
the visible light count, so toggling lights would recompile every lit material
in the level mid-firefight.

---

## Known limitations

Being straight about where this lands versus the bar:

- **Shadows are a single follow-frustum with texel snapping, not true
  cascades.** The frustum recentres on the player each frame and snaps to whole
  texels so edges do not crawl. It gives crisp shadows out to ~50m and none
  beyond, where fog covers for it. Real CSM in Three needs per-material shader
  patching, which is a large fragility budget for distant shadows in a fogged
  scene.
- **Screen-space AO is best-effort.** `GTAOPass` is loaded by dynamic import and
  the demo falls back to the baked AO maps if it fails to load, because it is
  the most version-fragile pass in the addons set.
- **Column flutes are additive strips, not cut geometry.** There is no CSG here;
  they read correctly at gameplay distance and not at nose distance.
- **No touch or gamepad input.** Desktop, mouse and keyboard only.
- **Enemies hover rather than walk.** That is a deliberate choice — a procedural
  walk cycle at this budget looks worse than no walk cycle, and hovering is
  truer to "drone" anyway.

## Licence

Same licence as the containing repository.
