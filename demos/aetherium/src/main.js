import * as THREE from 'three';
import { Context } from './core/context.js';
import { EventBus } from './core/bus.js';
import { Rng } from './core/rng.js';
import { Loop } from './core/loop.js';
import { detectPreset, makeQuality, PRESET_ORDER } from './core/quality.js';
import { RenderSystem } from './render/render.js';
import { MaterialSystem } from './materials/materials.js';
import { SkySystem } from './sky/sky.js';
import { WorldSystem } from './world/world.js';
import { PhysicsSystem } from './physics/physics.js';
import { PlayerSystem } from './player/player.js';
import { WeaponSystem } from './weapons/weapons.js';
import { FxSystem } from './fx/fx.js';
import { AiSystem } from './ai/ai.js';
import { UiSystem } from './ui/ui.js';
import { GameSystem } from './ui/game.js';
import { AudioSystem } from './audio/audio.js';

const SETTINGS_KEY = 'aetherium.settings.v2';

const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  fov: 76,
  volume: 0.65,
  invertY: false,
  showPerf: false
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    // Private-mode browsers throw on localStorage; defaults are fine.
    return { ...DEFAULT_SETTINGS };
  }
}

async function boot() {
  const canvas = document.getElementById('c');
  const ctx = new Context();

  ctx.bus = new EventBus();
  ctx.settings = loadSettings();
  ctx.saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(ctx.settings));
    } catch (_) { /* ignore */ }
  };

  // A fixed seed by default so the archipelago, patrol routes and texture
  // grain are identical run to run — which is what makes the capture tooling
  // able to diff screenshots at all. ?seed= overrides it.
  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : 0x4145544d;
  ctx.rng = new Rng(seed);
  ctx.quality = makeQuality(detectPreset());
  ctx.gameOver = false;

  const loadLabel = document.getElementById('loadLabel');
  const loadBar = document.getElementById('loadBar');
  const stages = [
    'Booting renderer', 'Synthesising materials', 'Raising Elysium Prime',
    'Charting patrol routes', 'Arming'
  ];
  let stageBase = 0;
  ctx.onProgress = (p, label) => {
    if (label) loadLabel.textContent = label;
    const total = (stageBase + Math.min(1, Math.max(0, p))) / stages.length;
    loadBar.style.width = (total * 100).toFixed(1) + '%';
  };

  // Registration order is also update order: render sets up the scene, world
  // needs materials, physics needs world colliders, ai needs the navgrid.
  const render = ctx.register('render', new RenderSystem(canvas));
  const materials = ctx.register('materials', new MaterialSystem());
  const sky = ctx.register('sky', new SkySystem());
  const world = ctx.register('world', new WorldSystem());
  const physics = ctx.register('physics', new PhysicsSystem());
  const player = ctx.register('player', new PlayerSystem());
  const weapons = ctx.register('weapons', new WeaponSystem());
  const fx = ctx.register('fx', new FxSystem());
  const ai = ctx.register('ai', new AiSystem());
  const audio = ctx.register('audio', new AudioSystem());
  const ui = ctx.register('ui', new UiSystem());
  const game = ctx.register('game', new GameSystem());

  // Bring each system up one at a time, letting the browser paint the loading
  // bar between them.
  const order = ['render', 'materials', 'sky', 'world', 'physics', 'player',
    'weapons', 'fx', 'ai', 'audio', 'ui', 'game'];
  const stageOf = {
    render: 0, materials: 1, sky: 1, world: 2, physics: 2,
    player: 4, weapons: 4, fx: 4, ai: 3, audio: 4, ui: 4, game: 4
  };

  for (const name of order) {
    stageBase = stageOf[name];
    ctx.onProgress(0, stages[stageBase]);
    await new Promise((r) => requestAnimationFrame(r));
    const s = ctx.get(name);
    if (s.init) await s.init();
  }

  stageBase = 3;
  ctx.onProgress(0, 'Charting patrol routes');
  await new Promise((r) => requestAnimationFrame(r));
  await ctx.readyAll();

  stageBase = 4;
  ctx.onProgress(1, 'Ready');

  const loop = new Loop(ctx, () => render.render());
  ctx.loopRef = loop;

  _wireLifecycle(ctx, loop, ui, player, audio, game);

  ui.setProgress(1, 'Ready');
  ui.showLoading(false);
  ui.showOverlay(true);
  loop.start();

  // Expose a small surface for the headless tools. Deliberately narrow — this
  // is a test hook, not a debug console.
  window.AETHERIUM = {
    ctx, loop,
    version: '2.0.0',
    quality: ctx.quality.name,
    presets: PRESET_ORDER,
    stats: () => ({
      fps: loop.fps,
      frameMs: loop.avgFrameMs,
      p95: loop.percentile(0.95),
      drawCalls: render.drawCalls,
      renderScale: render._renderScale,
      drones: ai.aliveCount,
      navCells: ai.nav ? ai.nav.walkableCount : 0,
      colliders: physics.colliders.length,
      stage: game.stage ? game.stage.id : null,
      playerPos: player.position.toArray().map((v) => +v.toFixed(2)),
      hp: player.hp,
      ammo: weapons.ammo
    }),
    teleport: (x, y, z) => player.respawn(new THREE.Vector3(x, y, z)),
    startGame: () => document.getElementById('startBtn').click()
  };

  console.info(
    `[aetherium] ready — preset ${ctx.quality.label}, ` +
    `${physics.colliders.length} colliders, ` +
    `${ai.nav.walkableCount} nav cells, seed 0x${seed.toString(16)}`
  );
}

function _wireLifecycle(ctx, loop, ui, player, audio, game) {
  const startBtn = document.getElementById('startBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const restartBtn = document.getElementById('restartBtn');
  const againBtn = document.getElementById('againBtn');

  let started = false;

  const beginRun = () => {
    audio.start();
    if (!started) {
      started = true;
      game.begin();
    }
    ui.showOverlay(false);
    ui.showPause(false);
    ui.hideDebrief();
    ui.showHud(true);
    ctx.paused = false;
    player.requestLock();
  };

  startBtn.addEventListener('click', beginRun);
  resumeBtn.addEventListener('click', beginRun);
  againBtn.addEventListener('click', () => {
    game.restart();
    beginRun();
  });
  restartBtn.addEventListener('click', () => {
    game.restart();
    beginRun();
  });

  ctx.bus.on('pointerlock:change', (e) => {
    if (e.locked) {
      ctx.paused = false;
      ui.showPause(false);
      ui.showOverlay(false);
      audio.resume();
    } else if (started && !ctx.gameOver) {
      // Losing the lock is a pause, not a game over.
      ctx.paused = true;
      ui.showPause(true);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && started && !ctx.gameOver) {
      // The browser releases the lock itself; the handler above shows the menu.
      ctx.paused = true;
    }
    if (e.code === 'F1') {
      e.preventDefault();
      ctx.settings.showPerf = !ctx.settings.showPerf;
      document.getElementById('perf').classList.toggle('hidden', !ctx.settings.showPerf);
      const box = document.getElementById('setPerf');
      if (box) box.checked = ctx.settings.showPerf;
      ctx.saveSettings();
    }
  });

  // Pause when the tab is hidden: a backgrounded game that keeps simulating is
  // a dead battery, and the accumulator would have to swallow the gap anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      ctx.paused = true;
      audio.suspend();
    }
  });

}

boot().catch((err) => {
  console.error('[aetherium] boot failed:', err);
  const label = document.getElementById('loadLabel');
  if (label) {
    label.innerHTML =
      `<span style="color:#ff8f7a">Failed to start:</span> ${err.message}` +
      `<br><span style="opacity:.7;font-size:.85em">` +
      `The demo needs WebGL2 and a static server — see README.md</span>`;
  }
});
