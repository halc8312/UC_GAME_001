import { describe, expect, it } from 'vitest';
import {
  TEXTURE_KINDS, TextureLibrary, createCanvasTexture, fbm2D, generatePixels,
  heightToAlphaMask, heightToNormalMap, heightToRoughness, makeSeedTable, valueNoise2D,
} from '../../src/engine/textures.js';
import { MATERIAL_NAMES } from '../../src/engine/materials.js';
import { Rng } from '../../src/core/rng.js';

const table = makeSeedTable(new Rng(1234));
const SIZE = 64; // small but representative; the shipped library uses 256

const fields = new Map();
const field = (kind) => {
  if (!fields.has(kind)) fields.set(kind, generatePixels(kind, SIZE, new Rng(99)));
  return fields.get(kind);
};

const channelStats = (data) => {
  const n = data.length / 4;
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    sum[0] += data[i * 4];
    sum[1] += data[i * 4 + 1];
    sum[2] += data[i * 4 + 2];
  }
  const mean = sum.map((s) => s / n);
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    const m = (mean[0] + mean[1] + mean[2]) / 3;
    varSum += (lum - m) ** 2;
  }
  return { mean, variance: varSum / n };
};

describe('noise', () => {
  it('makeSeedTable produces a permutation of the requested size', () => {
    const t = makeSeedTable(new Rng(7), 256);
    expect(t.size).toBe(256);
    expect(new Set(t.perm).size).toBe(256);
    expect(t.vals.length).toBe(256);
  });

  it('is deterministic for a fixed seed', () => {
    const a = makeSeedTable(new Rng(42));
    const b = makeSeedTable(new Rng(42));
    expect(Array.from(a.perm)).toEqual(Array.from(b.perm));
    expect(valueNoise2D(3.7, 9.2, a)).toBe(valueNoise2D(3.7, 9.2, b));
  });

  it('valueNoise2D stays in [0,1] over many samples', () => {
    for (let i = 0; i < 5000; i++) {
      const v = valueNoise2D(i * 0.137, i * 0.271, table);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('valueNoise2D is continuous: small input deltas give small output deltas', () => {
    let maxJump = 0;
    for (let i = 0; i < 400; i++) {
      const x = i * 0.31;
      const a = valueNoise2D(x, 5.5, table);
      const b = valueNoise2D(x + 0.002, 5.5, table);
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }
    expect(maxJump).toBeLessThan(0.05);
  });

  it('fbm2D stays in [0,1] and varies with position', () => {
    const samples = [];
    for (let i = 0; i < 2000; i++) {
      const v = fbm2D(i * 0.11, i * 0.07, 4, 2, 0.5, table);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      samples.push(v);
    }
    expect(new Set(samples.map((v) => v.toFixed(3))).size).toBeGreaterThan(100);
  });

  it('fbm2D with more octaves adds detail without leaving range', () => {
    const low = fbm2D(2.5, 3.5, 1, 2, 0.5, table);
    const high = fbm2D(2.5, 3.5, 6, 2, 0.5, table);
    expect(Number.isFinite(low)).toBe(true);
    expect(Number.isFinite(high)).toBe(true);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe('generatePixels', () => {
  it.each(TEXTURE_KINDS)('%s produces a full RGBA buffer and height field', (kind) => {
    const f = field(kind);
    expect(f.size).toBe(SIZE);
    expect(f.data.length).toBe(SIZE * SIZE * 4);
    expect(f.height.length).toBe(SIZE * SIZE);
    for (let i = 0; i < f.height.length; i += 37) {
      expect(f.height[i]).toBeGreaterThanOrEqual(0);
      expect(f.height[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = generatePixels('concrete', 32, new Rng(5));
    const b = generatePixels('concrete', 32, new Rng(5));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it.each(TEXTURE_KINDS)('%s is not a flat constant colour', (kind) => {
    const { variance } = channelStats(field(kind).data);
    expect(variance).toBeGreaterThan(4);
  });

  it.each([
    ['concrete', 'steel_rusted'],
    ['concrete', 'water'],
    ['grating', 'hazard_stripe'],
    ['crate_wood', 'panel_wall'],
    ['screen_static', 'rubber_mat'],
    ['steel_painted', 'steel_rusted'],
    ['water', 'sand_wet'],
  ])('%s and %s are visually distinguishable', (a, b) => {
    const ma = channelStats(field(a).data).mean;
    const mb = channelStats(field(b).data).mean;
    const dist = Math.hypot(ma[0] - mb[0], ma[1] - mb[1], ma[2] - mb[2]);
    expect(dist).toBeGreaterThan(12);
  });

  it('grating is a cut-out: its height field is strongly bimodal', () => {
    const h = field('grating').height;
    let low = 0;
    let high = 0;
    for (const v of h) {
      if (v < 0.35) low++;
      else high++;
    }
    expect(low).toBeGreaterThan(h.length * 0.05);
    expect(high).toBeGreaterThan(h.length * 0.2);
  });

  it('hazard stripes alternate between two strong values', () => {
    const h = field('hazard_stripe').height;
    let low = 0;
    let high = 0;
    for (const v of h) {
      if (v < 0.3) low++;
      else if (v > 0.7) high++;
    }
    expect(low).toBeGreaterThan(h.length * 0.15);
    expect(high).toBeGreaterThan(h.length * 0.15);
  });

  it('an unknown kind falls back without throwing', () => {
    expect(() => generatePixels('does_not_exist', 16, new Rng(1))).not.toThrow();
  });
});

describe('derived maps', () => {
  it('a flat height field yields a flat normal map centred on blue', () => {
    const flat = new Float32Array(SIZE * SIZE).fill(0.5);
    const n = heightToNormalMap(flat, SIZE, 2);
    for (let i = 0; i < n.length; i += 4 * 53) {
      expect(n[i]).toBeCloseTo(128, -1);
      expect(n[i + 1]).toBeCloseTo(128, -1);
      expect(n[i + 2]).toBeGreaterThan(200);
    }
  });

  it('a noisy height field yields a non-flat normal map', () => {
    const n = heightToNormalMap(field('concrete').height, SIZE, 2);
    let offCentre = 0;
    for (let i = 0; i < n.length; i += 4) {
      if (Math.abs(n[i] - 128) > 6 || Math.abs(n[i + 1] - 128) > 6) offCentre++;
    }
    expect(offCentre).toBeGreaterThan((n.length / 4) * 0.15);
  });

  it('normal maps are fully opaque and in range', () => {
    const n = heightToNormalMap(field('steel_rusted').height, SIZE, 2);
    for (let i = 0; i < n.length; i += 4) {
      expect(n[i + 3]).toBe(255);
      expect(n[i]).toBeGreaterThanOrEqual(0);
      expect(n[i]).toBeLessThanOrEqual(255);
    }
  });

  it('roughness tracks the height field within the configured band', () => {
    const r = heightToRoughness(field('concrete').height, SIZE, 0.8, 0.3);
    for (let i = 0; i < r.length; i += 4) {
      expect(r[i]).toBeGreaterThanOrEqual(0);
      expect(r[i]).toBeLessThanOrEqual(255);
      expect(r[i]).toBe(r[i + 1]);
    }
  });

  // Three samples alphaMap's GREEN channel; a mask that only sets alpha silently
  // does nothing, which is what broke the catwalk grating.
  it('the alpha mask writes the cut-out into the colour channels', () => {
    const m = heightToAlphaMask(field('grating').height, SIZE, 0.35);
    let opaque = 0;
    let cut = 0;
    for (let i = 0; i < m.length; i += 4) {
      expect(m[i]).toBe(m[i + 1]);
      expect(m[i + 1]).toBe(m[i + 2]);
      expect(m[i + 3]).toBe(255);
      if (m[i + 1] === 255) opaque++;
      else cut++;
    }
    expect(opaque).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(0);
  });
});

describe('library behaviour without a DOM', () => {
  it('constructing a TextureLibrary does not throw in Node', () => {
    expect(() => new TextureLibrary(null, { size: 32 })).not.toThrow();
  });

  it('get/normal/roughness/alpha return null with no document', () => {
    const lib = new TextureLibrary(null, { size: 32 });
    expect(lib.get('concrete')).toBeNull();
    expect(lib.normal('concrete')).toBeNull();
    expect(lib.roughness('concrete')).toBeNull();
    expect(lib.alpha('grating')).toBeNull();
    expect(() => lib.dispose()).not.toThrow();
  });

  it('createCanvasTexture returns null with no document', () => {
    expect(createCanvasTexture('concrete', { size: 16 })).toBeNull();
  });

  it('the material name list covers everything the level builder asks for', () => {
    const required = [
      'floor_concrete', 'wall_concrete', 'wall_panel', 'steel', 'steel_dark', 'rust',
      'grating', 'glass', 'water', 'hazard', 'crate', 'screen', 'emissive_amber',
      'emissive_red', 'emissive_green', 'pipe', 'rubber', 'enemy_body', 'enemy_visor',
      'weapon_body', 'weapon_dark', 'decal_bullet',
    ];
    for (const name of required) expect(MATERIAL_NAMES).toContain(name);
  });

  it('covers every surface kind the level uses', () => {
    for (const kind of ['concrete', 'concrete_wet', 'steel_painted', 'grating', 'water']) {
      expect(TEXTURE_KINDS).toContain(kind);
    }
    expect(TEXTURE_KINDS.length).toBeGreaterThanOrEqual(15);
  });
});
