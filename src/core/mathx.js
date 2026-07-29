/** Small, allocation-free math helpers shared by pure simulation modules. */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPS = 1e-6;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPS));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach.
 * `lambda` is the rate: higher converges faster. dt in seconds.
 */
export function damp(current, target, lambda, dt) {
  return lerp(target, current, Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
}

/** Wrap an angle into [-PI, PI). */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Shortest signed angular difference from a to b. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

// ---------------------------------------------------------------------------
// Minimal vec3 on plain objects. Pure modules avoid importing three so the unit
// suite runs in Node with no DOM and no renderer.
// ---------------------------------------------------------------------------

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const v3set = (o, x, y, z) => ((o.x = x), (o.y = y), (o.z = z), o);
export const v3copy = (o, a) => ((o.x = a.x), (o.y = a.y), (o.z = a.z), o);
export const v3add = (o, a, b) => v3set(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const v3sub = (o, a, b) => v3set(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const v3scale = (o, a, s) => v3set(o, a.x * s, a.y * s, a.z * s);
export const v3addScaled = (o, a, b, s) =>
  v3set(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3lenSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const v3len = (a) => Math.sqrt(v3lenSq(a));
export const v3distSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const v3dist = (a, b) => Math.sqrt(v3distSq(a, b));

export function v3normalize(o, a = o) {
  const l = v3len(a);
  if (l < EPS) return v3set(o, 0, 0, 0);
  return v3set(o, a.x / l, a.y / l, a.z / l);
}

export function v3cross(o, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return v3set(o, x, y, z);
}

/** Planar (XZ) distance — the one gameplay actually cares about most. */
export const planarDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Percentile of a numeric array (does not mutate). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * s.length) - 1, 0, s.length - 1);
  return s[idx];
}

export const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
