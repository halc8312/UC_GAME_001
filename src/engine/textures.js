import { clamp, clamp01, lerp, smoothstep } from '../core/mathx.js';
import { Rng } from '../core/rng.js';

/**
 * Procedural texture generation. The game ships zero image files: every surface is
 * a height field synthesized here, converted to colour, normal and roughness maps.
 *
 * The pure half (noise, `generatePixels`, the map converters) has no DOM
 * dependency so it is unit-testable in Node; the `TextureLibrary` half wraps it in
 * canvases and Three textures and degrades to `null` when there is no document.
 */

export const TEXTURE_KINDS = [
  'concrete', 'concrete_wet', 'steel_painted', 'steel_rusted', 'grating',
  'glass_dirty', 'water', 'hazard_stripe', 'panel_wall', 'crate_wood',
  'screen_static', 'emissive_strip', 'sand_wet', 'pipe_metal', 'rubber_mat',
];

const TABLE_SIZE = 256;

export function makeSeedTable(rng, size = TABLE_SIZE) {
  const perm = new Uint8Array(size);
  const vals = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    perm[i] = i;
    vals[i] = rng.next();
  }
  for (let i = size - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  return { perm, vals, size, mask: size - 1 };
}

const fade = (t) => t * t * (3 - 2 * t);

/** Tileable value noise in [0,1]. `period` keeps the field wrapping seamlessly. */
export function valueNoise2D(x, y, table, period = 256) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const m = table.mask;
  const p = table.perm;
  const v = table.vals;
  const wrap = (n) => ((n % period) + period) % period;
  const x0 = wrap(xi) & m, x1 = wrap(xi + 1) & m;
  const y0 = wrap(yi) & m, y1 = wrap(yi + 1) & m;
  const a = v[(p[x0] + y0) & m];
  const b = v[(p[x1] + y0) & m];
  const c = v[(p[x0] + y1) & m];
  const d = v[(p[x1] + y1) & m];
  const u = fade(xf);
  const w = fade(yf);
  return lerp(lerp(a, b, u), lerp(c, d, u), w);
}

export function fbm2D(x, y, octaves, lacunarity, gain, table, period = 256) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2D(x * freq, y * freq, table, Math.max(1, Math.round(period * freq))) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Worley-ish cellular field, used for concrete aggregate and rust pitting. */
function cell2D(x, y, table, cells = 8) {
  const cx = Math.floor(x * cells);
  const cy = Math.floor(y * cells);
  let best = 1e9;
  let second = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = ((cx + ox) % cells + cells) % cells;
      const gy = ((cy + oy) % cells + cells) % cells;
      const h = table.vals[(table.perm[gx & table.mask] + gy) & table.mask];
      const h2 = table.vals[(table.perm[(gx + 37) & table.mask] + gy * 3) & table.mask];
      const px = (cx + ox + h) / cells;
      const py = (cy + oy + h2) / cells;
      const dx = x - px;
      const dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) {
        second = best;
        best = d;
      } else if (d < second) second = d;
    }
  }
  return clamp01(Math.sqrt(second) - Math.sqrt(best));
}

const PALETTES = {
  concrete: [[0.28, 0.29, 0.29], [0.78, 0.77, 0.73]],
  concrete_wet: [[0.14, 0.16, 0.18], [0.52, 0.55, 0.58]],
  steel_painted: [[0.16, 0.21, 0.25], [0.54, 0.61, 0.66]],
  steel_rusted: [[0.24, 0.13, 0.08], [0.62, 0.34, 0.17]],
  grating: [[0.10, 0.11, 0.12], [0.36, 0.38, 0.40]],
  glass_dirty: [[0.32, 0.40, 0.44], [0.60, 0.70, 0.74]],
  water: [[0.05, 0.13, 0.18], [0.16, 0.34, 0.40]],
  hazard_stripe: [[0.08, 0.08, 0.08], [0.92, 0.66, 0.10]],
  panel_wall: [[0.14, 0.17, 0.20], [0.64, 0.69, 0.73]],
  crate_wood: [[0.28, 0.19, 0.11], [0.62, 0.46, 0.28]],
  screen_static: [[0.02, 0.06, 0.09], [0.20, 0.66, 0.80]],
  emissive_strip: [[0.10, 0.09, 0.06], [1.00, 0.74, 0.36]],
  sand_wet: [[0.24, 0.21, 0.17], [0.48, 0.43, 0.35]],
  pipe_metal: [[0.14, 0.15, 0.17], [0.56, 0.58, 0.61]],
  rubber_mat: [[0.04, 0.05, 0.05], [0.34, 0.35, 0.36]],
};

/**
 * Height field for one surface kind, in [0,1]. Each kind combines a different set
 * of primitives so the results are distinguishable at a glance, not just different
 * shades of the same noise.
 */
function heightFor(kind, u, v, t) {
  switch (kind) {
    case 'concrete': {
      const agg = cell2D(u, v, t, 14);
      const grunge = fbm2D(u * 5, v * 5, 4, 2.1, 0.5, t);
      const stain = smoothstep(0.55, 0.95, fbm2D(u * 1.4 + 3, v * 1.4, 3, 2, 0.55, t));
      // Pour lines: without them a large wall reads as one featureless slab.
      const seamU = 1 - smoothstep(0.0, 0.03, Math.abs(((u * 2) % 1) - 0.5) - 0.47);
      const seamV = 1 - smoothstep(0.0, 0.03, Math.abs(((v * 2) % 1) - 0.5) - 0.47);
      const seam = Math.max(seamU, seamV);
      return clamp01(0.55 + agg * 0.22 + (grunge - 0.5) * 0.34 - stain * 0.22 - seam * 0.28);
    }
    case 'concrete_wet': {
      const agg = cell2D(u, v, t, 11);
      const pools = smoothstep(0.42, 0.78, fbm2D(u * 2.2 + 9, v * 2.2, 4, 2, 0.55, t));
      return clamp01(0.5 + agg * 0.16 - pools * 0.34 + (fbm2D(u * 8, v * 8, 3, 2, 0.5, t) - 0.5) * 0.16);
    }
    case 'steel_painted': {
      // Brushed metal: strongly anisotropic, plus panel seams.
      const brush = fbm2D(u * 34, v * 3.5, 3, 2.3, 0.55, t);
      const seamX = smoothstep(0.02, 0.0, Math.abs(((u * 3) % 1) - 0.5) - 0.47);
      const wear = smoothstep(0.6, 1.0, fbm2D(u * 3 + 17, v * 3, 4, 2, 0.5, t));
      return clamp01(0.62 + (brush - 0.5) * 0.09 - seamX * 0.3 - wear * 0.18);
    }
    case 'steel_rusted': {
      // Rust runs downward: bias the noise along v.
      const run = fbm2D(u * 6, v * 1.6, 5, 2.2, 0.55, t);
      const pit = cell2D(u, v, t, 22);
      const patch = smoothstep(0.38, 0.72, fbm2D(u * 2.4 + 5, v * 2.4, 3, 2, 0.6, t));
      return clamp01(0.4 + run * 0.3 + pit * 0.18 + patch * 0.3);
    }
    case 'grating': {
      // Regular perforation: bars in both axes with a gap between.
      const gx = Math.abs(((u * 8) % 1) - 0.5);
      const gy = Math.abs(((v * 8) % 1) - 0.5);
      const bar = Math.max(smoothstep(0.30, 0.38, gx), smoothstep(0.40, 0.47, gy));
      const grime = fbm2D(u * 10, v * 10, 3, 2, 0.5, t);
      return clamp01(bar * (0.72 + grime * 0.22));
    }
    case 'glass_dirty': {
      const smear = fbm2D(u * 3.5, v * 1.2, 4, 2.4, 0.5, t);
      const specks = smoothstep(0.86, 1.0, fbm2D(u * 26, v * 26, 2, 2, 0.5, t));
      return clamp01(0.72 + (smear - 0.5) * 0.26 - specks * 0.4);
    }
    case 'water': {
      // Two ripple systems at different scales and directions.
      const a = fbm2D(u * 7, v * 3.5, 4, 2.1, 0.55, t);
      const b = fbm2D(u * 3 + 21, v * 9, 3, 2.4, 0.5, t);
      return clamp01(0.42 + (a - 0.5) * 0.5 + (b - 0.5) * 0.35);
    }
    case 'hazard_stripe': {
      const s = ((u + v) * 5) % 1;
      const stripe = smoothstep(0.46, 0.54, Math.abs(s - 0.5) * 2);
      const wear = smoothstep(0.55, 0.95, fbm2D(u * 6, v * 6, 3, 2, 0.5, t));
      return clamp01(stripe * (1 - wear * 0.55));
    }
    case 'panel_wall': {
      const px = Math.abs(((u * 2) % 1) - 0.5);
      const py = Math.abs(((v * 3) % 1) - 0.5);
      const seam = Math.min(smoothstep(0.44, 0.5, px), smoothstep(0.42, 0.5, py));
      const bolts = smoothstep(0.90, 1.0, cell2D(u * 1.0, v * 1.5, t, 6));
      const grunge = fbm2D(u * 7, v * 7, 3, 2, 0.5, t);
      return clamp01(0.6 + (1 - seam) * -0.3 + bolts * 0.25 + (grunge - 0.5) * 0.14);
    }
    case 'crate_wood': {
      // Plank grain: high-frequency along the plank, banded across it.
      const plank = Math.floor(v * 5);
      const grain = fbm2D(u * 22 + plank * 7, v * 3, 4, 2.2, 0.55, t);
      const gap = smoothstep(0.46, 0.5, Math.abs(((v * 5) % 1) - 0.5));
      return clamp01((0.5 + (grain - 0.5) * 0.55) * (0.35 + gap * 0.65));
    }
    case 'screen_static': {
      const scan = (Math.sin(v * Math.PI * 2 * 72) * 0.5 + 0.5) ** 2;
      const blocks = fbm2D(u * 14, v * 8, 2, 2, 0.5, t);
      return clamp01(0.25 + scan * 0.35 + blocks * 0.45);
    }
    case 'emissive_strip': {
      const band = smoothstep(0.28, 0.42, Math.abs(v - 0.5));
      const flick = fbm2D(u * 5, v * 2, 2, 2, 0.5, t);
      return clamp01((1 - band) * (0.75 + flick * 0.3));
    }
    case 'sand_wet': {
      const ripple = (Math.sin(u * 30 + fbm2D(u * 2, v * 2, 3, 2, 0.5, t) * 8) * 0.5 + 0.5);
      const grain = fbm2D(u * 40, v * 40, 2, 2, 0.5, t);
      return clamp01(0.45 + ripple * 0.24 + (grain - 0.5) * 0.2);
    }
    case 'pipe_metal': {
      const ring = smoothstep(0.42, 0.5, Math.abs(((v * 6) % 1) - 0.5));
      const brush = fbm2D(u * 3, v * 40, 3, 2.2, 0.5, t);
      return clamp01(0.55 + ring * 0.2 + (brush - 0.5) * 0.2);
    }
    case 'rubber_mat': {
      const stud = cell2D(u, v, t, 18);
      const grain = fbm2D(u * 30, v * 30, 2, 2, 0.5, t);
      return clamp01(0.35 + stud * 0.4 + (grain - 0.5) * 0.12);
    }
    default:
      return fbm2D(u * 4, v * 4, 4, 2, 0.5, t);
  }
}

/**
 * Generate RGBA pixels plus the underlying height field.
 * @returns {{data:Uint8ClampedArray, height:Float32Array, size:number}}
 */
export function generatePixels(kind, size = 256, rngIn) {
  const rng = rngIn || new Rng(0xc0ffee ^ hashString(kind));
  const table = makeSeedTable(rng, TABLE_SIZE);
  const data = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const pal = PALETTES[kind] || PALETTES.concrete;
  const [lo, hi] = pal;

  // A slow large-scale tint field stops every surface reading as flat noise.
  const macroTable = makeSeedTable(new Rng(0x51de ^ hashString(kind)), TABLE_SIZE);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const h = heightFor(kind, u, v, table);
      const macro = fbm2D(u * 1.6, v * 1.6, 3, 2, 0.6, macroTable);
      const shade = clamp01((h - 0.5) * 1.25 + 0.5) * 0.84 + macro * 0.16;

      let r = lerp(lo[0], hi[0], shade);
      let g = lerp(lo[1], hi[1], shade);
      let b = lerp(lo[2], hi[2], shade);

      // Per-kind colour accents.
      if (kind === 'steel_rusted') {
        const rustAmt = clamp01((h - 0.45) * 2.1);
        r = lerp(r, 0.55 + macro * 0.18, rustAmt);
        g = lerp(g, 0.26 + macro * 0.10, rustAmt);
        b = lerp(b, 0.12, rustAmt);
      } else if (kind === 'hazard_stripe') {
        const on = h > 0.5;
        r = on ? 0.93 : 0.07;
        g = on ? 0.68 : 0.07;
        b = on ? 0.10 : 0.08;
        const wear = clamp01(1 - Math.abs(h - 0.5) * 1.4);
        r *= 1 - wear * 0.25;
        g *= 1 - wear * 0.25;
      } else if (kind === 'screen_static') {
        const hot = clamp01((h - 0.55) * 2.4);
        r = lerp(r, 0.32, hot);
        g = lerp(g, 0.86, hot);
        b = lerp(b, 1.0, hot);
      } else if (kind === 'water') {
        const crest = clamp01((h - 0.55) * 2.6);
        r = lerp(r, 0.34, crest);
        g = lerp(g, 0.52, crest);
        b = lerp(b, 0.58, crest);
      }

      const i = (y * size + x) * 4;
      data[i] = r * 255;
      data[i + 1] = g * 255;
      data[i + 2] = b * 255;
      // Grating is a cut-out: the gaps must be transparent, not dark.
      data[i + 3] = kind === 'grating' ? (h > 0.35 ? 255 : 0) : 255;
      height[y * size + x] = h;
    }
  }
  return { data, height, size };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Sobel-style normal map from a height field. Output is a tangent-space RGBA map. */
export function heightToNormalMap(heightData, size, strength = 2.0) {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => heightData[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Cut-out mask from a height field, written to all channels.
 *
 * Three's `alphaMap` samples the GREEN channel, not the alpha channel, so feeding
 * it a colour map silently produces a mask made of that map's greenness. The
 * grating either vanishes entirely or never cuts out at all, depending on the
 * palette. This produces an explicit mask instead.
 */
export function heightToAlphaMask(heightData, size, threshold = 0.35) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < heightData.length; i++) {
    const v = heightData[i] > threshold ? 255 : 0;
    const j = i * 4;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

export function heightToRoughness(heightData, size, base = 0.75, range = 0.3) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < heightData.length; i++) {
    const r = clamp01(base + (heightData[i] - 0.5) * range) * 255;
    const j = i * 4;
    out[j] = r;
    out[j + 1] = r;
    out[j + 2] = r;
    out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM-dependent half
// ---------------------------------------------------------------------------

const hasDOM = () => typeof document !== 'undefined' && !!document.createElement;

function pixelsToCanvas(pixels, size) {
  if (!hasDOM()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @returns {import('three').CanvasTexture|null} null when there is no DOM. */
export function createCanvasTexture(kind, opts = {}) {
  if (!hasDOM()) return null;
  const THREE = opts.three;
  if (!THREE) return null;
  const size = opts.size ?? 256;
  const { data } = generatePixels(kind, size, opts.rng);
  const canvas = pixelsToCanvas(data, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Memoized colour/normal/roughness textures for every surface kind. */
export class TextureLibrary {
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.size = opts.size ?? 256;
    this.anisotropy = opts.anisotropy ?? 4;
    this._color = new Map();
    this._normal = new Map();
    this._rough = new Map();
    this._alpha = new Map();
    this._fields = new Map();
    this.stats = { created: 0, disposed: 0, ms: 0 };
    this._disposed = false;
  }

  _field(kind) {
    let f = this._fields.get(kind);
    if (!f) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      f = generatePixels(kind, this.size, new Rng(0xc0ffee ^ hashString(kind)));
      this.stats.ms += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      this._fields.set(kind, f);
    }
    return f;
  }

  _make(pixels, srgb) {
    const THREE = this.THREE;
    const canvas = pixelsToCanvas(pixels, this.size);
    if (!canvas) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.stats.created++;
    return tex;
  }

  get(kind) {
    if (this._disposed || !hasDOM()) return null;
    let t = this._color.get(kind);
    if (!t) {
      t = this._make(this._field(kind).data, true);
      this._color.set(kind, t);
    }
    return t;
  }

  normal(kind, strength = 2.0) {
    if (this._disposed || !hasDOM()) return null;
    let t = this._normal.get(kind);
    if (!t) {
      const f = this._field(kind);
      t = this._make(heightToNormalMap(f.height, f.size, strength), false);
      this._normal.set(kind, t);
    }
    return t;
  }

  roughness(kind, base = 0.75, range = 0.35) {
    if (this._disposed || !hasDOM()) return null;
    let t = this._rough.get(kind);
    if (!t) {
      const f = this._field(kind);
      t = this._make(heightToRoughness(f.height, f.size, base, range), false);
      this._rough.set(kind, t);
    }
    return t;
  }

  alpha(kind, threshold = 0.35) {
    if (this._disposed || !hasDOM()) return null;
    let t = this._alpha.get(kind);
    if (!t) {
      const f = this._field(kind);
      t = this._make(heightToAlphaMask(f.height, f.size, threshold), false);
      this._alpha.set(kind, t);
    }
    return t;
  }

  dispose() {
    for (const map of [this._color, this._normal, this._rough, this._alpha]) {
      for (const t of map.values()) {
        t?.dispose?.();
        this.stats.disposed++;
      }
      map.clear();
    }
    this._fields.clear();
    this._disposed = true;
  }
}
