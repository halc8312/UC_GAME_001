/**
 * Deterministic PRNG (mulberry32). All gameplay randomness routes through this so a
 * seeded run reproduces exactly — required by GAME_SPEC §6 and enforced by
 * tests/unit/determinism.test.js.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed(seed);
  }

  seed(n) {
    this._s = (n >>> 0) || 1;
    this._calls = 0;
    return this;
  }

  /** @returns {number} uniform in [0,1) */
  next() {
    this._calls++;
    let t = (this._s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** uniform in [min,max) */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** integer in [min,max] inclusive */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** true with probability p */
  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** Approximately normal via sum of 3 uniforms; clamped to ±3 sigma-ish. */
  gauss(mean = 0, sd = 1) {
    const u = this.next() + this.next() + this.next() - 1.5;
    return mean + u * 2 * sd * 0.4082482904638631 * 2;
  }

  /** Uniform point on the unit disc, written into `out`. */
  disc(out = { x: 0, y: 0 }) {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next());
    out.x = Math.cos(a) * r;
    out.y = Math.sin(a) * r;
    return out;
  }

  /** Snapshot / restore so tests can fork a stream. */
  save() {
    return { s: this._s, calls: this._calls };
  }

  restore(state) {
    this._s = state.s >>> 0;
    this._calls = state.calls;
    return this;
  }
}

/** Shared simulation RNG. Reseeded by the mission director at mission start. */
export const rng = new Rng(0x5eed1234);
