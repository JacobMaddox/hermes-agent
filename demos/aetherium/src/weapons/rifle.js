import * as THREE from 'three';
import { boxGeo, cylGeo, torusGeo, mergeByMaterial } from '../world/geo.js';
import { LAYER_VIEWMODEL } from '../render/render.js';

// The Kestrel-pattern plasma carbine, built procedurally.
//
// Round 1's weapon was five boxes and a cylinder. This is the same idea taken
// seriously: a receiver with real proportions, a vented shroud, a skeletal
// stock, a holographic optic with a floating reticle, and an aim point the
// viewmodel rig aligns to the screen centre for aim-down-sights.
//
// The ~60 static pieces are merged down to one mesh per material before they
// ever reach the scene — a viewmodel is on screen every single frame, so it is
// the last place to spend sixty draw calls. Only the parts that animate on
// their own (the cell, the charge bar, the trigger, the optic) stay separate.
//
// Everything lands on the viewmodel layer so the second render pass draws it
// with the depth buffer cleared and it can never clip through a wall.

export function buildRifle(mats) {
  const group = new THREE.Group();
  group.name = 'rifle';

  const body = mats.get('gunmetal');
  const dark = mats.get('darkMetal');
  const glow = mats.get('aether');

  const skin = new THREE.MeshStandardMaterial({
    color: 0x7a5540, roughness: 0.78, metalness: 0.0
  });
  const glove = new THREE.MeshStandardMaterial({
    color: 0x23262e, roughness: 0.72, metalness: 0.15
  });

  // Static parts are collected, not added, so they can be merged at the end.
  const statics = [];
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3(1, 1, 1);
  const _p = new THREE.Vector3();

  const at = (x, y, z, rx = 0, ry = 0, rz = 0) => {
    _p.set(x, y, z);
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    return _m.compose(_p, _q, _s).clone();
  };

  const put = (geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
    statics.push({ geometry, material, matrix: at(x, y, z, rx, ry, rz) });
  };

  // ── Receiver ──────────────────────────────────────────────────────────
  put(boxGeo(0.085, 0.115, 0.44, 0.35), body, 0, 0, -0.10);
  put(boxGeo(0.072, 0.03, 0.40, 0.3), dark, 0, 0.072, -0.11);
  // Picatinny-style rail teeth.
  for (let i = 0; i < 7; i++) {
    put(boxGeo(0.078, 0.012, 0.016, 0.2), dark, 0, 0.09, -0.26 + i * 0.05);
  }
  put(boxGeo(0.006, 0.045, 0.10, 0.2), dark, 0.045, 0.012, -0.03);
  put(cylGeo(0.009, 0.009, 0.07, 6, 0.2), dark, 0.055, 0.05, 0.045, 0, 0, Math.PI / 2);

  // ── Handguard and barrel ──────────────────────────────────────────────
  put(boxGeo(0.075, 0.078, 0.30, 0.3), body, 0, -0.002, -0.40);
  for (let i = 0; i < 5; i++) {
    for (const s of [-1, 1]) {
      put(boxGeo(0.008, 0.034, 0.028, 0.15), dark, s * 0.038, 0.0, -0.31 - i * 0.05);
    }
  }
  put(boxGeo(0.036, 0.016, 0.24, 0.2), dark, 0, -0.046, -0.40);

  put(cylGeo(0.016, 0.018, 0.34, 12, 0.25), dark, 0, 0.004, -0.62, Math.PI / 2);
  put(cylGeo(0.028, 0.024, 0.075, 10, 0.2), dark, 0, 0.004, -0.80, Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    put(boxGeo(0.062, 0.008, 0.012, 0.15), dark, 0, 0.022, -0.785 + i * 0.022);
  }

  // ── Grip, guard and stock ─────────────────────────────────────────────
  put(boxGeo(0.05, 0.135, 0.06, 0.25), body, 0, -0.10, 0.055, 0.3);
  put(boxGeo(0.054, 0.02, 0.07, 0.2), dark, 0, -0.165, 0.078, 0.3);
  put(torusGeo(0.036, 0.006, 5, 12, Math.PI, 0.2), dark, 0, -0.052, 0.0, 0, Math.PI / 2, Math.PI);

  for (const s of [-1, 1]) {
    put(boxGeo(0.011, 0.011, 0.20, 0.15), dark, s * 0.026, 0.012, 0.20);
  }
  put(boxGeo(0.07, 0.028, 0.055, 0.2), body, 0, 0.038, 0.17);
  put(boxGeo(0.062, 0.10, 0.028, 0.25), body, 0, -0.015, 0.295);
  put(boxGeo(0.066, 0.036, 0.045, 0.2), dark, 0, -0.055, 0.285);

  // ── Optic housing ─────────────────────────────────────────────────────
  //
  // This is the part that has to have a hole in it. The first version used two
  // solid plates for the bezels, which meant aiming down the sight put a solid
  // slab across the middle of the screen — the lens and reticle were drawn in
  // front of it, so it looked like a sight right up until you tried to use it.
  //
  // The body is an open-ended tube and the bezels are rings, so the line from
  // the eye through APERTURE_R at the optic's centre is genuinely clear.
  const APERTURE_R = 0.019;
  const BEZEL_R = 0.029;

  // Mount block, below the sight line.
  put(boxGeo(0.044, 0.028, 0.11, 0.2), dark, 0, 0.10, -0.115);

  // The optic needs its own material because it is the one part of the weapon
  // that must render from both sides — you see the outside of the tube, and
  // through the aperture you see the inside of its far wall. Cloned rather
  // than mutating `dark`, which is shared with the entire world.
  const opticMat = dark.clone();
  opticMat.side = THREE.DoubleSide;
  opticMat.name = 'optic';

  // Tube: open at both ends, so the sight line passes straight through.
  const tube = cylGeo(BEZEL_R * 0.88, BEZEL_R * 0.88, 0.106, 20, 0.2, true);
  tube.rotateX(Math.PI / 2);
  statics.push({ geometry: tube, material: opticMat, matrix: at(0, 0.128, -0.115) });

  // Ring bezels front and rear — an annulus, not a plate.
  for (const z of [-0.168, -0.062]) {
    const ring = new THREE.RingGeometry(APERTURE_R, BEZEL_R, 24);
    statics.push({ geometry: ring, material: opticMat, matrix: at(0, 0.128, z) });
  }

  // ── Hands ─────────────────────────────────────────────────────────────
  // Left, wrapped around the handguard.
  put(new THREE.CapsuleGeometry(0.032, 0.055, 4, 8), glove, 0, -0.055, -0.40, 0.25, 0, 0.5);
  for (let i = 0; i < 4; i++) {
    put(new THREE.CapsuleGeometry(0.0115, 0.055, 3, 6), skin,
      -0.006 + i * 0.001, -0.028, -0.445 + i * 0.026, 1.15, 0, 0.15);
  }
  put(new THREE.CapsuleGeometry(0.013, 0.04, 3, 6), skin, 0.03, -0.05, -0.375, 0.5, 0, -0.7);
  put(new THREE.CapsuleGeometry(0.036, 0.10, 4, 8), glove, -0.02, -0.115, -0.31, -0.5, 0, 0.35);

  // Right, on the grip. The trigger finger is added separately below because
  // it animates.
  put(new THREE.CapsuleGeometry(0.033, 0.05, 4, 8), glove, 0.008, -0.10, 0.062, 0.3, 0, 0.35);
  for (let i = 0; i < 3; i++) {
    put(new THREE.CapsuleGeometry(0.011, 0.038, 3, 6), skin,
      -0.012, -0.088 - i * 0.024, 0.03, 0.15, 0, 1.35);
  }
  put(new THREE.CapsuleGeometry(0.038, 0.10, 4, 8), glove, 0.012, -0.155, 0.135, -0.45, 0, 0.2);

  // Merge everything static: five materials in, five meshes out.
  const merged = mergeByMaterial(statics);
  for (const m of merged) {
    m.castShadow = false;
    m.receiveShadow = false;
    group.add(m);
  }
  statics.forEach((s) => s.geometry.dispose());

  // ── Animated parts ────────────────────────────────────────────────────
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    group.add(m);
    return m;
  };

  // Energy cell: drops out and reseats during a reload.
  const cell = add(boxGeo(0.055, 0.115, 0.075, 0.2), dark, 0, -0.115, -0.075);
  const cellGlow = add(boxGeo(0.058, 0.055, 0.028, 0.15), glow, 0, -0.108, -0.041);
  // Charge window: scales with remaining ammo.
  const chargeBar = add(boxGeo(0.005, 0.014, 0.16, 0.15), glow, -0.046, 0.018, -0.12);
  // Trigger finger: pulls on fire.
  const trigger = add(new THREE.CapsuleGeometry(0.011, 0.042, 3, 6), skin,
    -0.010, -0.052, 0.006, 0.55, 0, 1.1);

  // Optic lens: additive and unlit, so it tints the view rather than veiling
  // it. Sized to the aperture and kept faint — this sits directly on the sight
  // line, so anything heavier here undoes the point of cutting the hole.
  const lens = add(
    new THREE.CircleGeometry(APERTURE_R, 20),
    new THREE.MeshBasicMaterial({
      color: 0x2a6fa8, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    }),
    0, 0.128, -0.055
  );

  // Floating reticle, only visible while aiming.
  const reticle = add(
    new THREE.RingGeometry(0.0035, 0.0055, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff5a3c, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      toneMapped: false
    }),
    0, 0.128, -0.048
  );
  reticle.renderOrder = 30;

  // ── Anchors ───────────────────────────────────────────────────────────
  const muzzleTip = new THREE.Object3D();
  muzzleTip.position.set(0, 0.004, -0.845);
  group.add(muzzleTip);

  // The point the rig aligns to screen centre when aiming.
  const aimPoint = new THREE.Object3D();
  aimPoint.position.set(0, 0.128, -0.11);
  group.add(aimPoint);

  group.traverse((o) => { o.layers.set(LAYER_VIEWMODEL); });

  return {
    group, aimPoint, muzzleTip, lens, reticle,
    cell, cellGlow, chargeBar, trigger,
    // Exposed so the weapon rig and the headless aperture test can both reason
    // about the sight line without duplicating the constant.
    apertureRadius: APERTURE_R
  };
}
