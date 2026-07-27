import * as THREE from 'three';
import { mergeByMaterial } from '../world/geo.js';

// Syndicate drones.
//
// Round 1's enemy was a capsule, a sphere, two arm capsules and two leg
// capsules — a mannequin, and it read as one. These hover instead of walking,
// which is both truer to "drone" and sidesteps the uncanny valley of a
// procedural walk cycle: a hovering chassis only needs bob, bank and yaw, and
// all three can be driven convincingly from velocity.
//
// The three archetypes are distinguishable by silhouette alone at range, which
// is the actual requirement — you should know what is shooting at you before
// you can read any detail.
//
// Each drone is built from ~20 primitives and merged down to three meshes:
// hull, dark fittings, and two emissive groups whose materials are cloned per
// drone so eye and thruster intensity can animate independently. Nine of these
// on screen at once is the temple fight, and 180 draw calls for it is not a
// budget worth spending.

export const ARCHETYPES = {
  skirmisher: {
    label: 'Skirmisher',
    hp: 70, speed: 6.4, accuracy: 0.72, fireRate: 0.42, burst: 3, burstGap: 1.35,
    damage: 7, range: 42, preferredRange: 14, aggression: 0.85,
    scale: 0.88, glow: 0xff4a20, telegraph: 0.28
  },
  sentry: {
    label: 'Sentry',
    hp: 110, speed: 2.4, accuracy: 0.88, fireRate: 0.75, burst: 2, burstGap: 1.7,
    damage: 12, range: 58, preferredRange: 26, aggression: 0.25,
    scale: 1.0, glow: 0xffb020, telegraph: 0.5
  },
  heavy: {
    label: 'Heavy',
    hp: 230, speed: 3.0, accuracy: 0.66, fireRate: 0.2, burst: 6, burstGap: 2.4,
    damage: 9, range: 34, preferredRange: 10, aggression: 0.95,
    scale: 1.32, glow: 0xff2d10, telegraph: 0.65
  }
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function at(x, y, z, rx = 0, ry = 0, rz = 0) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return _m.compose(_p, _q, _s).clone();
}

export function buildDrone(type, mats) {
  const A = ARCHETYPES[type];
  const group = new THREE.Group();
  group.name = `drone:${type}`;

  const plate = mats.get('dronePlate');
  const dark = mats.get('darkMetal');

  // Cloned per drone so one alert drone does not light up the whole squad.
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x2a0a04, emissive: A.glow, emissiveIntensity: 1.2,
    roughness: 0.4, metalness: 0.0
  });
  const jetMat = new THREE.MeshStandardMaterial({
    color: 0x1a0602, emissive: A.glow, emissiveIntensity: 1.6,
    roughness: 0.5, metalness: 0.0
  });

  const hull = [];
  const eyes = [];
  const jets = [];

  const put = (list, geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
    list.push({ geometry, material, matrix: at(x, y, z, rx, ry, rz) });
  };

  if (type === 'skirmisher') {
    // Narrow forward-raked body: fast, light, obviously mobile.
    const core = new THREE.OctahedronGeometry(0.42, 1);
    core.scale(0.72, 0.62, 1.5);
    put(hull, core, plate, 0, 0, 0);
    put(hull, new THREE.BoxGeometry(0.62, 0.1, 0.5), dark, 0, -0.16, 0.05);

    put(hull, new THREE.BoxGeometry(0.34, 0.2, 0.24), dark, 0, 0.14, -0.5, -0.22);
    put(eyes, new THREE.BoxGeometry(0.3, 0.07, 0.04), eyeMat, 0, 0.16, -0.62, -0.22);

    for (const s of [-1, 1]) {
      put(hull, new THREE.BoxGeometry(0.5, 0.05, 0.34), plate,
        s * 0.44, -0.02, 0.14, 0, s * 0.35, s * -0.2);
      put(hull, new THREE.CylinderGeometry(0.11, 0.13, 0.3, 10), dark,
        s * 0.66, -0.06, 0.26, Math.PI / 2 - 0.15, 0, 0);
      put(jets, new THREE.CylinderGeometry(0.085, 0.05, 0.06, 10), jetMat,
        s * 0.66, -0.08, 0.42, Math.PI / 2 - 0.15, 0, 0);
    }

    put(hull, new THREE.BoxGeometry(0.11, 0.11, 0.62), dark, 0, -0.22, -0.3);
    put(hull, new THREE.CylinderGeometry(0.032, 0.038, 0.26, 8), dark,
      0, -0.22, -0.68, Math.PI / 2);
  } else if (type === 'sentry') {
    // Boxy armoured torso on a stabiliser ring: reads as static and tough.
    put(hull, new THREE.BoxGeometry(0.78, 0.86, 0.6), plate, 0, 0, 0);
    for (const s of [-1, 1]) {
      put(hull, new THREE.BoxGeometry(0.16, 0.86, 0.3), plate, s * 0.44, 0, 0, 0, 0, s * 0.3);
    }
    put(hull, new THREE.BoxGeometry(0.86, 0.14, 0.68), dark, 0, 0.46, 0);
    put(hull, new THREE.BoxGeometry(0.86, 0.14, 0.68), dark, 0, -0.46, 0);

    put(hull, new THREE.BoxGeometry(0.42, 0.3, 0.42), dark, 0, 0.62, -0.06);
    put(eyes, new THREE.BoxGeometry(0.36, 0.1, 0.05), eyeMat, 0, 0.64, -0.28);
    put(hull, new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8), dark, 0, 0.82, -0.06);

    put(hull, new THREE.TorusGeometry(0.62, 0.055, 8, 22), dark, 0, -0.5, 0, Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      put(jets, new THREE.CylinderGeometry(0.07, 0.045, 0.09, 8), jetMat,
        Math.cos(a) * 0.62, -0.58, Math.sin(a) * 0.62);
    }

    for (const s of [-1, 1]) {
      put(hull, new THREE.BoxGeometry(0.14, 0.16, 0.5), dark, s * 0.42, 0.18, -0.28);
      put(hull, new THREE.CylinderGeometry(0.036, 0.042, 0.3, 8), dark,
        s * 0.42, 0.18, -0.62, Math.PI / 2);
    }
  } else {
    // Heavy: wide, layered, four big pods. Silhouette is all shoulders.
    put(hull, new THREE.BoxGeometry(1.05, 0.9, 0.82), plate, 0, 0, 0);
    put(hull, new THREE.BoxGeometry(1.24, 0.34, 0.92), plate, 0, 0.34, 0);
    put(hull, new THREE.BoxGeometry(0.9, 0.22, 0.7), dark, 0, -0.52, 0);
    put(hull, new THREE.BoxGeometry(0.6, 0.44, 0.1), dark, 0, 0.02, -0.44);
    put(eyes, new THREE.BoxGeometry(0.34, 0.24, 0.08), eyeMat, 0, 0.02, -0.49);

    put(hull, new THREE.BoxGeometry(0.5, 0.34, 0.46), dark, 0, 0.62, -0.1);
    put(eyes, new THREE.BoxGeometry(0.44, 0.1, 0.05), eyeMat, 0, 0.65, -0.34);
    put(hull, new THREE.BoxGeometry(0.54, 0.12, 0.2), plate, 0, 0.78, -0.24, -0.3);

    for (const s of [-1, 1]) {
      put(hull, new THREE.BoxGeometry(0.3, 0.3, 0.66), plate, s * 0.66, 0.3, -0.16);
      put(hull, new THREE.CylinderGeometry(0.06, 0.07, 0.42, 8), dark,
        s * 0.66, 0.3, -0.62, Math.PI / 2);
      for (const v of [-1, 1]) {
        put(hull, new THREE.CylinderGeometry(0.15, 0.17, 0.34, 10), dark,
          s * 0.7, v * 0.28, 0.44, Math.PI / 2);
        put(jets, new THREE.CylinderGeometry(0.12, 0.07, 0.08, 10), jetMat,
          s * 0.7, v * 0.28, 0.63, Math.PI / 2);
      }
    }
  }

  // The chassis banks and pitches with velocity; everything hangs off it.
  const chassis = new THREE.Group();
  group.add(chassis);

  const all = [...hull, ...eyes, ...jets];
  for (const mesh of mergeByMaterial(all)) {
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    chassis.add(mesh);
  }
  all.forEach((e) => e.geometry.dispose());

  group.scale.setScalar(A.scale);

  // Hitboxes in local space, scaled with the archetype. The head is small and
  // worth 2.3x; the body is generous so the weapon feels responsive.
  const headY = type === 'skirmisher' ? 0.16 : 0.62;
  const hitboxes = [
    { name: 'head', offset: new THREE.Vector3(0, headY * A.scale, -0.2 * A.scale), radius: 0.3 * A.scale, headshot: true },
    { name: 'body', offset: new THREE.Vector3(0, 0, 0), radius: 0.62 * A.scale, headshot: false }
  ];
  if (type === 'heavy') {
    for (const s of [-1, 1]) {
      hitboxes.push({
        name: s < 0 ? 'shoulderL' : 'shoulderR',
        offset: new THREE.Vector3(s * 0.66 * A.scale, 0.3 * A.scale, -0.16 * A.scale),
        radius: 0.34 * A.scale, headshot: false
      });
    }
  }

  const muzzles = [];
  if (type === 'skirmisher') muzzles.push(new THREE.Vector3(0, -0.22, -0.82).multiplyScalar(A.scale));
  else if (type === 'sentry') {
    for (const s of [-1, 1]) {
      muzzles.push(new THREE.Vector3(s * 0.42, 0.18, -0.78).multiplyScalar(A.scale));
    }
  } else {
    for (const s of [-1, 1]) {
      muzzles.push(new THREE.Vector3(s * 0.66, 0.3, -0.84).multiplyScalar(A.scale));
    }
  }

  return { group, chassis, eyeMat, jetMat, hitboxes, muzzles, archetype: A };
}
