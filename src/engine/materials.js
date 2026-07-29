import * as THREE from 'three';
import { TextureLibrary } from './textures.js';

export const MATERIAL_NAMES = [
  'floor_concrete', 'wall_concrete', 'wall_panel', 'steel', 'steel_dark', 'rust',
  'grating', 'glass', 'water', 'hazard', 'crate', 'screen', 'emissive_amber',
  'emissive_red', 'emissive_green', 'pipe', 'rubber', 'enemy_body', 'enemy_visor',
  'weapon_body', 'weapon_dark', 'weapon_glove', 'decal_bullet', 'enemy_accent',
];

/**
 * Material recipes. Colours are chosen for an ACES-filmic, sRGB-output renderer
 * with dense blue fog — under a neutral setup they would read as too saturated,
 * which is the correct trade for this scene.
 */
const RECIPES = {
  floor_concrete: { tex: 'concrete_wet', color: 0x8f959b, rough: 0.99, metal: 0.0, normal: 1.3, roughBase: 0.95, roughRange: 0.12 },
  wall_concrete: { tex: 'concrete', color: 0x969da2, rough: 0.99, metal: 0.0, normal: 1.7, roughBase: 0.95, roughRange: 0.14 },
  wall_panel: { tex: 'panel_wall', color: 0x818c95, rough: 0.9, metal: 0.06, normal: 1.9, roughBase: 0.88, roughRange: 0.16 },
  steel: { tex: 'steel_painted', color: 0x9aa4ac, rough: 0.86, metal: 0.12, roughRange: 0.2, normal: 0.9, roughBase: 0.72 },
  steel_dark: { tex: 'steel_painted', color: 0x808a92, rough: 0.9, metal: 0.08, roughRange: 0.2, normal: 0.8, roughBase: 0.78 },
  rust: { tex: 'steel_rusted', color: 0x8f6440, rough: 0.93, metal: 0.06, normal: 2.0, roughBase: 0.9 },
  pipe: { tex: 'pipe_metal', color: 0x88929a, rough: 0.42, metal: 0.85, normal: 1.1, roughBase: 0.4 },
  grating: {
    tex: 'grating', color: 0x767f86, rough: 0.94, metal: 0.1, normal: 1.0, roughBase: 0.92, roughRange: 0.14,
    alphaTest: 0.5, alphaKind: 'grating', side: THREE.DoubleSide,
  },
  glass: {
    tex: 'glass_dirty', color: 0x9fc4d6, rough: 0.14, metal: 0.05, normal: 0.6, roughBase: 0.2,
    transparent: true, opacity: 0.36, side: THREE.DoubleSide,
  },
  water: { tex: 'water', color: 0x3b5b70, rough: 0.14, metal: 0.5, normal: 1.6, roughBase: 0.16 },
  hazard: { tex: 'hazard_stripe', color: 0xcfc9bc, rough: 0.95, metal: 0.0, normal: 0.9, roughBase: 0.93, roughRange: 0.12 },
  crate: { tex: 'crate_wood', color: 0x9c8064, rough: 0.98, metal: 0.0, normal: 1.7, roughBase: 0.95, roughRange: 0.12 },
  rubber: { tex: 'rubber_mat', color: 0x565c60, rough: 0.99, metal: 0.0, normal: 1.6, roughBase: 0.96, roughRange: 0.1 },
  // Indigo, not cyan. Saturated cyan is reserved for contractor markings, and the
  // server room's forty-odd rack strips were spending it on scenery — in that
  // room the one colour that means "threat" meant "furniture".
  screen: {
    tex: 'screen_static', color: 0x1c2340, rough: 0.28, metal: 0.1, normal: 0.4, roughBase: 0.3,
    emissiveMap: true, emissive: 0x4f63e0, emissiveIntensity: 1.4,
  },
};

const SOLID_EMISSIVE = {
  emissive_amber: { color: 0x2a1c0c, emissive: 0xffb15e, intensity: 2.2 },
  emissive_red: { color: 0x2a0a08, emissive: 0xff3322, intensity: 1.2 },
  emissive_green: { color: 0x082a1c, emissive: 0x53ffbe, intensity: 2.4 },
  enemy_visor: { color: 0x0a1216, emissive: 0xff5a3c, intensity: 3.4 },
  // Reserved exclusively for contractor markings so a threat silhouette can never
  // be confused with facility signage or a pickup.
  enemy_accent: { color: 0x0d1a1e, emissive: 0x66f2ff, intensity: 2.8 },
};

/**
 * Memoized material library. Every material it creates is disposed by `dispose()`,
 * and `get()` never returns undefined — an unknown name yields a loud magenta
 * placeholder rather than a crash deep inside the renderer.
 */
export class MaterialLibrary {
  constructor(textures, opts = {}) {
    this.textures = textures || new TextureLibrary(THREE, opts);
    this._cache = new Map();
    this._created = [];
    this._time = 0;
    this.stats = { created: 0, disposed: 0 };
  }

  _track(mat) {
    this._created.push(mat);
    this.stats.created++;
    return mat;
  }

  _standard(name) {
    const r = RECIPES[name];
    const tex = this.textures;
    const params = {
      color: r.color,
      roughness: r.rough,
      metalness: r.metal,
    };
    const map = tex.get(r.tex);
    if (map) params.map = map;
    const nrm = tex.normal(r.tex, r.normal);
    if (nrm) {
      params.normalMap = nrm;
      params.normalScale = new THREE.Vector2(r.normal * 0.5, r.normal * 0.5);
    }
    const rgh = tex.roughness(r.tex, r.roughBase, r.roughRange ?? 0.35);
    if (rgh) params.roughnessMap = rgh;
    if (r.transparent) {
      params.transparent = true;
      if (r.opacity !== undefined) params.opacity = r.opacity;
    }
    if (r.alphaTest !== undefined) {
      // alphaTest without `transparent` keeps the mesh in the opaque pass, which
      // is what a cut-out grating wants: correct depth sorting, no blending cost.
      params.alphaTest = r.alphaTest;
      const mask = tex.alpha(r.alphaKind ?? r.tex);
      if (mask) params.alphaMap = mask;
    }
    if (r.side) params.side = r.side;
    if (r.emissiveMap && map) {
      params.emissive = new THREE.Color(r.emissive);
      params.emissiveMap = map;
      params.emissiveIntensity = r.emissiveIntensity ?? 1;
    }
    return this._track(new THREE.MeshStandardMaterial(params));
  }

  get(name) {
    let m = this._cache.get(name);
    if (m) return m;

    if (RECIPES[name]) {
      m = this._standard(name);
    } else if (SOLID_EMISSIVE[name]) {
      const e = SOLID_EMISSIVE[name];
      m = this._track(new THREE.MeshStandardMaterial({
        color: e.color,
        emissive: new THREE.Color(e.emissive),
        emissiveIntensity: e.intensity,
        roughness: 0.4,
        metalness: 0.1,
      }));
    } else if (name === 'enemy_body') {
      m = this._track(new THREE.MeshStandardMaterial({
        color: 0x232c36,
        roughness: 0.88,
        metalness: 0.05,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 1,
      }));
    } else if (name === 'weapon_body') {
      // Deliberately lighter than any world surface. The viewmodel is on screen
      // for the whole game against floors, crates and night sky in turn, and at
      // the original 0x4a5158 it disappeared into every one of them.
      m = this._track(new THREE.MeshStandardMaterial({
        color: 0x8b959f, roughness: 0.42, metalness: 0.58,
      }));
    } else if (name === 'weapon_dark') {
      m = this._track(new THREE.MeshStandardMaterial({
        color: 0x4d565f, roughness: 0.8, metalness: 0.16,
      }));
    } else if (name === 'weapon_glove') {
      // The player's hands. Separate from `enemy_body` so the two silhouettes
      // can be tuned independently — they are read for opposite reasons.
      m = this._track(new THREE.MeshStandardMaterial({
        color: 0x3d4753, roughness: 0.9, metalness: 0.04,
      }));
    } else if (name === 'decal_bullet') {
      m = this._track(this._decalMaterial());
    } else {
      console.warn(`[materials] unknown material "${name}" — using placeholder`);
      m = this._track(new THREE.MeshStandardMaterial({ color: 0xff00ff, roughness: 1 }));
    }

    this._cache.set(name, m);
    return m;
  }

  /** Bullet hole: a small procedurally drawn alpha sprite, no image file. */
  _decalMaterial() {
    let map = null;
    if (typeof document !== 'undefined') {
      const S = 64;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = S;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const dx = (x - S / 2) / (S / 2);
          const dy = (y - S / 2) / (S / 2);
          const d = Math.hypot(dx, dy);
          const core = 1 - Math.min(1, d / 0.34);
          const ring = Math.max(0, 1 - Math.abs(d - 0.5) / 0.34);
          const a = Math.min(1, core * 1.0 + ring * 0.42);
          const i = (y * S + x) * 4;
          const v = Math.round(26 + core * 14);
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v + 2;
          img.data[i + 3] = Math.round(a * 235);
        }
      }
      ctx.putImageData(img, 0, 0);
      map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      this._decalTexture = map;
    }
    const params = {
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    };
    if (map) {
      params.map = map;
      params.alphaMap = map;
    }
    return new THREE.MeshStandardMaterial(params);
  }

  /** Advance animated materials (currently just the water surface scroll). */
  tick(dt) {
    this._time += dt;
    const water = this._cache.get('water');
    if (water && water.map) {
      water.map.offset.x = (this._time * 0.021) % 1;
      water.map.offset.y = (this._time * 0.014) % 1;
      if (water.normalMap) {
        water.normalMap.offset.x = (this._time * -0.017) % 1;
        water.normalMap.offset.y = (this._time * 0.024) % 1;
      }
    }
  }

  dispose() {
    for (const m of this._created) {
      m.dispose();
      this.stats.disposed++;
    }
    this._created.length = 0;
    this._cache.clear();
    this._decalTexture?.dispose?.();
    this.textures.dispose();
  }
}
