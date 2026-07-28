import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACE, RAMP } from './collision.js';
import { CATWALK_Y, LIGHTS, SEA_LEVEL } from './leveldata.js';

const TILE = 2.4; // metres per texture tile — keeps texel density uniform

/**
 * Box geometry whose UVs are scaled by face size, so a 30 m wall and a 1 m crate
 * share the same texel density instead of stretching one texture across each.
 */
function boxWithUV(w, h, d, tile = TILE) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (4 verts each).
  const scales = [
    [d / tile, h / tile],
    [d / tile, h / tile],
    [w / tile, d / tile],
    [w / tile, d / tile],
    [w / tile, h / tile],
    [w / tile, h / tile],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = scales[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Wedge geometry for ramps, with the top face sloping along one axis. */
function rampGeometry(w, h, d, axis, dir) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.pos ?? geo.attributes.position;
  // Collapse the "low" end of the top face down to the base.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y <= 0) continue;
    const along = axis === 'x' ? x / (w / 2) : z / (d / 2);
    const t = dir > 0 ? (along + 1) / 2 : 1 - (along + 1) / 2;
    pos.setY(i, -h / 2 + h * t);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const uv = geo.attributes.uv;
  const scales = [
    [d / TILE, h / TILE], [d / TILE, h / TILE],
    [w / TILE, d / TILE], [w / TILE, d / TILE],
    [w / TILE, h / TILE], [w / TILE, h / TILE],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = scales[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Which material a collider is rendered with. Drives both look and merge batching. */
export function materialForCollider(c) {
  const tag = c.tag || '';
  if (tag === 'railing') return 'steel_dark';
  if (tag === 'rack') return 'steel_dark';
  if (tag === 'pipe' || tag === 'pump_stack' || tag === 'column') return 'pipe';
  if (tag === 'pump') return 'steel';
  if (tag === 'helipad') return 'floor_concrete';
  if (tag === 'core_pedestal' || tag === 'weapon_table') return 'steel';
  if (tag === 'yard') return 'floor_concrete';

  switch (c.surface) {
    case SURFACE.WOOD: return 'crate';
    case SURFACE.GRATE: return 'grating';
    case SURFACE.PANEL: return 'wall_panel';
    case SURFACE.RUBBER: return 'rubber';
    case SURFACE.GLASS: return 'glass';
    case SURFACE.METAL:
      return tag === 'crate' ? 'steel' : 'steel_dark';
    default: {
      const isFloor = c.max.y - c.min.y <= 1.2;
      return isFloor ? 'floor_concrete' : 'wall_concrete';
    }
  }
}

/**
 * Builds the visual level.
 *
 * Static geometry is merged per material so the whole facility costs roughly one
 * draw call per material rather than one per box — the difference between ~40 and
 * ~600 draw calls, which is the entire reason the frame budget in GAME_SPEC §2 is
 * achievable.
 */
export class LevelBuilder {
  constructor(scene, materials, colliders) {
    this.scene = scene;
    this.materials = materials;
    this.colliders = colliders;
    this.root = new THREE.Group();
    this.root.name = 'level';
    this.scene.add(this.root);
    this._geometries = [];
    this._materials = [];
    this._lights = [];
    this.lampLights = new Map();
    this.strobeLights = new Map();
    this.emissiveStrips = [];
    this.stats = { merged: 0, meshes: 0, triangles: 0 };
  }

  build() {
    this._buildStatic();
    this._buildRailings();
    this._buildWater();
    this._buildDetails();
    this._buildLights();
    return this;
  }

  _buildStatic() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    const groups = new Map();
    for (const c of this.colliders) {
      if (c.tag === 'yard') continue;    // handled separately, needs its own tiling
      if (c.tag === 'pump') continue;    // collision-only: the cylinder below is the visual
      if (c.tag === 'railing') continue; // collision-only: drawn as open rails below
      const name = materialForCollider(c);
      const w = c.max.x - c.min.x;
      const h = c.max.y - c.min.y;
      const d = c.max.z - c.min.z;
      if (w <= 0 || h <= 0 || d <= 0) continue;
      // Grating bars are a few centimetres across; at the 2.4 m default tile the
      // holes come out roughly a foot wide and the catwalk reads as a cargo net.
      const tile = c.surface === SURFACE.GRATE ? 0.55 : TILE;
      const geo =
        c.kind === RAMP
          ? rampGeometry(w, h, d, c.axis, c.dir)
          : boxWithUV(w, h, d, tile);
      geo.translate((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
      let list = groups.get(name);
      if (!list) groups.set(name, (list = []));
      list.push(geo);
    }

    for (const [name, geos] of groups) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.materials.get(name));
      mesh.name = `static_${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this._geometries.push(merged);
      this.stats.merged++;
      this.stats.triangles += merged.index
        ? merged.index.count / 3
        : merged.attributes.position.count / 3;
    }

    // The yard slab, tiled coarsely so it does not shimmer at distance.
    const yard = this.colliders.find((c) => c.tag === 'yard');
    if (yard) {
      const g = boxWithUV(
        yard.max.x - yard.min.x, yard.max.y - yard.min.y, yard.max.z - yard.min.z, 6,
      );
      g.translate(
        (yard.min.x + yard.max.x) / 2,
        (yard.min.y + yard.max.y) / 2,
        (yard.min.z + yard.max.z) / 2,
      );
      const m = new THREE.Mesh(g, this.materials.get('floor_concrete'));
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.root.add(m);
      this._geometries.push(g);
    }
  }

  /**
   * Railings, drawn as posts and rails rather than as the solid slabs they collide
   * with.
   *
   * The colliders have to stay solid — falling off a catwalk would strand the
   * player below the level — but rendering them as 1.1 m parapets walls the player
   * in visually and hides the sea the whole facility is built over. Splitting the
   * physical barrier from the visual one is the standard fix.
   */
  _buildRailings() {
    const posts = [];
    const rails = [];
    const POST = 0.075;
    for (const c of this.colliders) {
      if (c.tag !== 'railing') continue;
      const w = c.max.x - c.min.x;
      const d = c.max.z - c.min.z;
      const h = c.max.y - c.min.y;
      const alongX = w >= d;
      const length = alongX ? w : d;
      const cx = (c.min.x + c.max.x) / 2;
      const cz = (c.min.z + c.max.z) / 2;

      // Two horizontal rails: top cap and a mid rail.
      for (const frac of [1.0, 0.52]) {
        const y = c.min.y + h * frac - POST / 2;
        const g = alongX
          ? new THREE.BoxGeometry(length, POST, Math.min(d, POST))
          : new THREE.BoxGeometry(Math.min(w, POST), POST, length);
        g.translate(cx, y, cz);
        rails.push(g);
      }

      // Uprights every ~1.6 m, always one at each end.
      const count = Math.max(2, Math.round(length / 1.6));
      for (let i = 0; i <= count; i++) {
        const t = i / count;
        const g = new THREE.BoxGeometry(POST, h, POST);
        const px = alongX ? c.min.x + length * t : cx;
        const pz = alongX ? cz : c.min.z + length * t;
        g.translate(
          Math.min(c.max.x - POST / 2, Math.max(c.min.x + POST / 2, px)),
          c.min.y + h / 2,
          Math.min(c.max.z - POST / 2, Math.max(c.min.z + POST / 2, pz)),
        );
        posts.push(g);
      }
    }

    const all = [...rails, ...posts];
    if (!all.length) return;
    const merged = mergeGeometries(all);
    for (const g of all) g.dispose();
    const mesh = new THREE.Mesh(merged, this.materials.get('pipe'));
    mesh.name = 'static_railings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this._geometries.push(merged);
    this.stats.merged++;
    this.stats.triangles += merged.index
      ? merged.index.count / 3
      : merged.attributes.position.count / 3;
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(600, 600, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = this.materials.get('water');
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.set(6, SEA_LEVEL, 6);
    this.water.receiveShadow = false;
    this.water.renderOrder = -10;
    this.root.add(this.water);
    this._geometries.push(geo);
  }

  _buildDetails() {
    const add = (mesh) => {
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.stats.meshes++;
      return mesh;
    };

    // Pump bodies as cylinders on top of their box colliders — reads as machinery
    // instead of yet another crate.
    const pumpGeo = new THREE.CylinderGeometry(2.05, 2.2, 3.0, 18, 1);
    this._geometries.push(pumpGeo);
    for (const [px, pz] of [[-9, 8], [-9, 19], [4, 8], [4, 19]]) {
      const m = new THREE.Mesh(pumpGeo, this.materials.get('rust'));
      m.position.set(px, 1.5, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      add(m);
      const capGeo = new THREE.TorusGeometry(2.1, 0.14, 6, 20);
      capGeo.rotateX(Math.PI / 2);
      this._geometries.push(capGeo);
      const cap = new THREE.Mesh(capGeo, this.materials.get('steel'));
      cap.position.set(px, 2.85, pz);
      add(cap);
    }

    // Hazard borders on the pad edges only. Striping the whole 14x14 m deck (the
    // first attempt) turned the extraction arena into unreadable zebra noise.
    const borderGeo = [
      boxWithUV(14, 0.05, 0.9, 1.0).translate(37, CATWALK_Y + 0.01, -5.4),
      boxWithUV(14, 0.05, 0.9, 1.0).translate(37, CATWALK_Y + 0.01, 7.4),
      boxWithUV(0.9, 0.05, 12.8, 1.0).translate(43.4, CATWALK_Y + 0.01, 1),
      boxWithUV(0.9, 0.05, 6, 1.0).translate(30.6, CATWALK_Y + 0.01, -2.6),
    ];
    const borders = mergeGeometries(borderGeo);
    for (const g of borderGeo) g.dispose();
    this._geometries.push(borders);
    add(new THREE.Mesh(borders, this.materials.get('hazard')));

    // Helipad "H" and touchdown circle.
    const ringGeo = new THREE.RingGeometry(4.4, 5.0, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this._geometries.push(ringGeo);
    const ring = new THREE.Mesh(ringGeo, this.materials.get('emissive_amber'));
    ring.position.set(37, CATWALK_Y + 0.02, 1);
    add(ring);
    const hGeo = mergeGeometries([
      new THREE.BoxGeometry(0.55, 0.04, 3.6).translate(-1.3, 0, 0),
      new THREE.BoxGeometry(0.55, 0.04, 3.6).translate(1.3, 0, 0),
      new THREE.BoxGeometry(2.1, 0.04, 0.55),
    ]);
    this._geometries.push(hGeo);
    const hMark = new THREE.Mesh(hGeo, this.materials.get('emissive_amber'));
    hMark.position.set(37, CATWALK_Y + 0.03, 1);
    add(hMark);

    // Server rack faces: emissive strips give the room its blue read.
    const rackFaces = [];
    for (let i = 0; i < 4; i++) {
      const x = -19 + i * 5.2 + 0.7;
      for (const [z0, z1] of [[-34, -26.5], [-24.5, -18]]) {
        for (let z = z0 + 0.6; z < z1 - 0.4; z += 1.5) {
          rackFaces.push(new THREE.BoxGeometry(1.5, 0.06, 0.9).translate(x, 1.9 - ((z - z0) % 3) * 0.35, z));
        }
      }
    }
    if (rackFaces.length) {
      const merged = mergeGeometries(rackFaces);
      for (const g of rackFaces) g.dispose();
      const m = new THREE.Mesh(merged, this.materials.get('screen'));
      this._geometries.push(merged);
      add(m);
      this.emissiveStrips.push(m);
    }

    // Data core. A fully emissive body blows out to a featureless white slab under
    // ACES, so the casing is dark and only a narrow seam and the cap emit.
    const coreBodyGeo = new THREE.CylinderGeometry(0.30, 0.34, 0.92, 12);
    const coreSeamGeo = new THREE.TorusGeometry(0.315, 0.028, 6, 16);
    coreSeamGeo.rotateX(Math.PI / 2);
    const coreCapGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.07, 12);
    this._geometries.push(coreBodyGeo, coreSeamGeo, coreCapGeo);

    this.dataCoreMesh = new THREE.Group();
    const coreBody = new THREE.Mesh(coreBodyGeo, this.materials.get('steel_dark'));
    coreBody.castShadow = true;
    const coreSeam = new THREE.Mesh(coreSeamGeo, this.materials.get('emissive_green'));
    coreSeam.position.y = 0.06;
    const coreCap = new THREE.Mesh(coreCapGeo, this.materials.get('emissive_green'));
    coreCap.position.y = 0.5;
    this.dataCoreMesh.add(coreBody, coreSeam, coreCap);
    this.dataCoreMesh.position.set(-10, 1.5, -30);
    this.root.add(this.dataCoreMesh);
    // A dedicated light so the objective prop is the brightest thing in the room.
    const coreLight = new THREE.PointLight(0x53ffbe, 26, 9, 2);
    coreLight.position.set(-10, 1.7, -30);
    this.root.add(coreLight);
    this._lights.push(coreLight);

    // Breaker panels on the hall walls.
    const panelGeo = boxWithUV(0.5, 1.1, 0.9, 1.2);
    this._geometries.push(panelGeo);
    for (const [x, z] of [[-19.6, 12], [13.6, 16]]) {
      const m = new THREE.Mesh(panelGeo, this.materials.get('steel'));
      m.position.set(x, 1.5, z);
      add(m);
    }

    // Sodium lamp fixtures. Each gets a stem and a mounting plate: a shade hovering
    // in mid-air is one of the fastest ways to make a scene read as unfinished.
    const lampGeo = new THREE.CylinderGeometry(0.26, 0.4, 0.34, 10);
    const bulbGeo = new THREE.SphereGeometry(0.22, 10, 8);
    const stemGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 6);
    const plateGeo = new THREE.BoxGeometry(0.34, 0.08, 0.34);
    this._geometries.push(lampGeo, bulbGeo, stemGeo, plateGeo);
    for (const l of LIGHTS) {
      if (l.kind !== 'lamp') continue;
      const housing = new THREE.Mesh(lampGeo, this.materials.get('steel_dark'));
      housing.position.set(l.x, l.y + 0.22, l.z);
      housing.castShadow = true;
      add(housing);
      const bulb = new THREE.Mesh(bulbGeo, this.materials.get('emissive_amber'));
      bulb.position.set(l.x, l.y, l.z);
      add(bulb);
      const stem = new THREE.Mesh(stemGeo, this.materials.get('pipe'));
      stem.position.set(l.x, l.y + 0.39 + (l.stem ?? 0.5) / 2, l.z);
      stem.scale.y = l.stem ?? 0.5;
      add(stem);
      const plate = new THREE.Mesh(plateGeo, this.materials.get('steel_dark'));
      plate.position.set(l.x, l.y + 0.39 + (l.stem ?? 0.5), l.z);
      add(plate);
    }

    // Alarm strobes: a small dome under a housing, not a bare floating sphere.
    const strobeGeo = new THREE.SphereGeometry(0.11, 8, 6);
    const strobeHousingGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.09, 8);
    this._geometries.push(strobeGeo, strobeHousingGeo);
    for (const l of LIGHTS) {
      if (l.kind !== 'strobe') continue;
      const dome = new THREE.Mesh(strobeGeo, this.materials.get('emissive_red').clone());
      dome.position.set(l.x, l.y, l.z);
      dome.matrixAutoUpdate = true;
      this.root.add(dome);
      this._materials.push(dome.material);
      this.emissiveStrips.push(dome);
      this.strobeLights.set(l.id + '_mesh', dome);
      const cap = new THREE.Mesh(strobeHousingGeo, this.materials.get('steel_dark'));
      cap.position.set(l.x, l.y + 0.1, l.z);
      add(cap);
    }

    // Hazard chevrons at the two doorways that matter for wayfinding.
    const chevGeo = boxWithUV(6, 0.12, 0.5, 1.0);
    this._geometries.push(chevGeo);
    for (const [x, y, z] of [[0, 0.02, 26.6], [-1, 0.02, -2.6], [-1, 0.02, -15.4]]) {
      const m = new THREE.Mesh(chevGeo, this.materials.get('hazard'));
      m.position.set(x, y, z);
      add(m);
    }
  }

  _buildLights() {
    for (const l of LIGHTS) {
      const light = new THREE.PointLight(
        l.color,
        l.kind === 'strobe' ? 0 : l.intensity,
        l.distance,
        2,
      );
      light.position.set(l.x, l.y, l.z);
      if (l.shadow) {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.camera.near = 0.4;
        light.shadow.camera.far = l.distance;
        light.shadow.bias = -0.004;
      }
      this.root.add(light);
      this._lights.push(light);
      if (l.kind === 'strobe') this.strobeLights.set(l.id, light);
      else this.lampLights.set(l.id, light);
    }
  }

  /** Alarm strobes: pulse intensity and emissive so the state is unmistakable. */
  updateAlarm(t, on, reducedFlash) {
    const pulse = reducedFlash ? 0.55 : (Math.sin(t * 7.2) * 0.5 + 0.5) ** 2;
    for (const [id, light] of this.strobeLights) {
      if (id.endsWith('_mesh')) {
        light.material.emissiveIntensity = on ? 0.5 + pulse * 1.6 : 0.1;
        continue;
      }
      light.intensity = on ? pulse * 110 : 0;
    }
  }

  /** Lamp flicker during the power-down beat. */
  setLampScale(scale) {
    for (const [id, light] of this.lampLights) {
      const base = LIGHTS.find((l) => l.id === id);
      if (base) light.intensity = base.intensity * scale;
    }
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
      }
      if (o.isLight && o.shadow?.map) o.shadow.map.dispose();
    });
    for (const g of this._geometries) g.dispose?.();
    this._geometries.length = 0;
    this.scene.remove(this.root);
  }
}
