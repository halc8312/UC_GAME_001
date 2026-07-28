import { clamp, EPS } from '../../core/mathx.js';

export const SOLID = 0;
export const RAMP = 1;

/** Surface tags drive impact particles, decal colour, and footstep audio. */
export const SURFACE = {
  CONCRETE: 'concrete',
  METAL: 'metal',
  GRATE: 'grate',
  GLASS: 'glass',
  WATER: 'water',
  WOOD: 'wood',
  PANEL: 'panel',
  RUBBER: 'rubber',
  FLESH: 'flesh',
};

let _nextId = 1;

/**
 * @param {number[]} min [x,y,z]
 * @param {number[]} max [x,y,z]
 */
export function box(min, max, surface = SURFACE.CONCRETE, opts = {}) {
  return {
    id: _nextId++,
    kind: SOLID,
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    surface,
    tag: opts.tag || '',
    noClip: !!opts.noClip,     // visual only, ignored by movement
    blocksSight: opts.blocksSight !== false,
  };
}

/**
 * A ramp is a footprint whose top surface rises linearly along one axis.
 * It is floor-only: side faces do not block, which keeps resolution simple and is
 * safe because every ramp in the level is flanked by real walls or railings.
 *
 * @param {'x'|'z'} axis axis the slope rises along
 * @param {number} dir +1 rises toward max, -1 rises toward min
 */
export function ramp(min, max, axis, dir, surface = SURFACE.METAL, opts = {}) {
  const b = box(min, max, surface, opts);
  b.kind = RAMP;
  b.axis = axis;
  b.dir = dir;
  const run = axis === 'x' ? b.max.x - b.min.x : b.max.z - b.min.z;
  const rise = b.max.y - b.min.y;
  b.slopeDeg = Math.atan2(rise, run) * (180 / Math.PI);
  return b;
}

/** Top-surface height of a ramp at a world XZ position (clamped to footprint). */
export function rampHeightAt(r, x, z) {
  const t =
    r.axis === 'x'
      ? clamp((x - r.min.x) / Math.max(EPS, r.max.x - r.min.x), 0, 1)
      : clamp((z - r.min.z) / Math.max(EPS, r.max.z - r.min.z), 0, 1);
  const u = r.dir > 0 ? t : 1 - t;
  return r.min.y + (r.max.y - r.min.y) * u;
}

const overlaps1 = (aMin, aMax, bMin, bMax) => aMin < bMax && aMax > bMin;

// ---------------------------------------------------------------------------

/** Uniform-grid broadphase over static colliders. Rebuilt once at level load. */
export class CollisionWorld {
  constructor(cellSize = 8) {
    this.cellSize = cellSize;
    this.colliders = [];
    this._grid = new Map();
    this._scratch = [];
    this._seen = new Set();
    this.bounds = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };
  }

  add(collider) {
    this.colliders.push(collider);
    return collider;
  }

  addAll(list) {
    for (const c of list) this.add(c);
    return this;
  }

  _key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663;
  }

  build() {
    this._grid.clear();
    const cs = this.cellSize;
    for (const c of this.colliders) {
      if (c.noClip) continue;
      this.bounds.min.x = Math.min(this.bounds.min.x, c.min.x);
      this.bounds.min.y = Math.min(this.bounds.min.y, c.min.y);
      this.bounds.min.z = Math.min(this.bounds.min.z, c.min.z);
      this.bounds.max.x = Math.max(this.bounds.max.x, c.max.x);
      this.bounds.max.y = Math.max(this.bounds.max.y, c.max.y);
      this.bounds.max.z = Math.max(this.bounds.max.z, c.max.z);
      const x0 = Math.floor(c.min.x / cs), x1 = Math.floor(c.max.x / cs);
      const z0 = Math.floor(c.min.z / cs), z1 = Math.floor(c.max.z / cs);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = this._key(cx, cz);
          let list = this._grid.get(k);
          if (!list) this._grid.set(k, (list = []));
          list.push(c);
        }
      }
    }
    return this;
  }

  /** Colliders whose AABB overlaps the query box. Result array is reused. */
  query(minX, minY, minZ, maxX, maxY, maxZ) {
    const out = this._scratch;
    out.length = 0;
    this._seen.clear();
    const cs = this.cellSize;
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this._grid.get(this._key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (this._seen.has(c.id)) continue;
          if (
            overlaps1(minX, maxX, c.min.x, c.max.x) &&
            overlaps1(minY, maxY, c.min.y, c.max.y) &&
            overlaps1(minZ, maxZ, c.min.z, c.max.z)
          ) {
            this._seen.add(c.id);
            out.push(c);
          }
        }
      }
    }
    return out;
  }

  /** True if the given AABB intersects any solid (used for headroom / spawn checks). */
  overlapsSolid(minX, minY, minZ, maxX, maxY, maxZ) {
    const hits = this.query(minX, minY, minZ, maxX, maxY, maxZ);
    for (let i = 0; i < hits.length; i++) if (hits[i].kind === SOLID) return true;
    return false;
  }

  /**
   * Highest supporting surface at (x,z) at or below `fromY` (+ a small tolerance).
   * @returns {{y:number, collider:object}|null}
   */
  groundAt(x, z, fromY, tolerance = 0.05) {
    const hits = this.query(x - 0.01, -1e4, z - 0.01, x + 0.01, fromY + tolerance, z + 0.01);
    let best = null;
    for (let i = 0; i < hits.length; i++) {
      const c = hits[i];
      const top = c.kind === RAMP ? rampHeightAt(c, x, z) : c.max.y;
      if (top <= fromY + tolerance && (!best || top > best.y)) best = { y: top, collider: c };
    }
    return best;
  }

  /**
   * Ray vs. world (slab test per AABB; ramps use their bounding box).
   * @returns {{hit:boolean, dist:number, point:object, normal:object, collider:object|null}}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 1000, opts = {}) {
    const sightOnly = !!opts.sight;
    const res = {
      hit: false,
      dist: maxDist,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 0 },
      collider: null,
    };
    // March the broadphase grid along the ray so long shots stay cheap.
    const cs = this.cellSize;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDy = dy !== 0 ? 1 / dy : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;

    const stepsX = Math.abs(dx) * maxDist / cs;
    const stepsZ = Math.abs(dz) * maxDist / cs;
    const samples = Math.min(96, Math.max(2, Math.ceil(Math.max(stepsX, stepsZ)) + 2));
    this._seen.clear();
    const checked = this._seen;

    for (let s = 0; s < samples; s++) {
      const t0 = (s / samples) * maxDist;
      const t1 = ((s + 1) / samples) * maxDist;
      const pad = 0.001;
      const ax = ox + dx * t0, ay = oy + dy * t0, az = oz + dz * t0;
      const bx = ox + dx * t1, by = oy + dy * t1, bz = oz + dz * t1;
      const list = this.query(
        Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.min(az, bz) - pad,
        Math.max(ax, bx) + pad, Math.max(ay, by) + pad, Math.max(az, bz) + pad,
      );
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (checked.has('r' + c.id)) continue;
        checked.add('r' + c.id);
        if (sightOnly && !c.blocksSight) continue;

        let tmin = 0, tmax = res.dist;
        let nx = 0, ny = 0, nz = 0;

        // X slab
        let t1a = (c.min.x - ox) * invDx, t2a = (c.max.x - ox) * invDx;
        let sgn = -1;
        if (t1a > t2a) { const tmp = t1a; t1a = t2a; t2a = tmp; sgn = 1; }
        if (t1a > tmin) { tmin = t1a; nx = sgn; ny = 0; nz = 0; }
        if (t2a < tmax) tmax = t2a;
        if (tmin > tmax) continue;

        // Y slab
        t1a = (c.min.y - oy) * invDy; t2a = (c.max.y - oy) * invDy; sgn = -1;
        if (t1a > t2a) { const tmp = t1a; t1a = t2a; t2a = tmp; sgn = 1; }
        if (t1a > tmin) { tmin = t1a; nx = 0; ny = sgn; nz = 0; }
        if (t2a < tmax) tmax = t2a;
        if (tmin > tmax) continue;

        // Z slab
        t1a = (c.min.z - oz) * invDz; t2a = (c.max.z - oz) * invDz; sgn = -1;
        if (t1a > t2a) { const tmp = t1a; t1a = t2a; t2a = tmp; sgn = 1; }
        if (t1a > tmin) { tmin = t1a; nx = 0; ny = 0; nz = sgn; }
        if (t2a < tmax) tmax = t2a;
        if (tmin > tmax) continue;

        if (tmin >= 0 && tmin < res.dist) {
          res.hit = true;
          res.dist = tmin;
          res.normal.x = nx; res.normal.y = ny; res.normal.z = nz;
          res.collider = c;
        }
      }
      if (res.hit && res.dist <= t1) break;
    }

    if (res.hit) {
      res.point.x = ox + dx * res.dist;
      res.point.y = oy + dy * res.dist;
      res.point.z = oz + dz * res.dist;
    }
    return res;
  }

  /** Convenience: is there an unobstructed line between two points? */
  lineOfSight(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < EPS) return true;
    dx /= d; dy /= d; dz /= d;
    const r = this.raycast(ax, ay, az, dx, dy, dz, d - 0.05, { sight: true });
    return !r.hit;
  }
}

// ---------------------------------------------------------------------------
// Character movement
// ---------------------------------------------------------------------------

export const MOVE_DEFAULTS = {
  radius: 0.35,
  height: 1.8,
  stepHeight: 0.45,
  slopeLimitDeg: 50,
  skin: 0.001,
  groundSnap: 0.28,
};

function resolveAxis(world, pos, half, height, axis, delta, out) {
  if (delta === 0) return false;
  pos[axis] += delta;
  const minX = pos.x - half, maxX = pos.x + half;
  const minY = pos.y + 0.02, maxY = pos.y + height;
  const minZ = pos.z - half, maxZ = pos.z + half;
  const hits = world.query(minX, minY, minZ, maxX, maxY, maxZ);
  let blocked = false;
  for (let i = 0; i < hits.length; i++) {
    const c = hits[i];
    if (c.kind !== SOLID) continue;
    // Re-test: earlier pushes in this loop may have already separated us.
    const pMinX = pos.x - half, pMaxX = pos.x + half;
    const pMinZ = pos.z - half, pMaxZ = pos.z + half;
    if (!overlaps1(pMinX, pMaxX, c.min.x, c.max.x)) continue;
    if (!overlaps1(minY, maxY, c.min.y, c.max.y)) continue;
    if (!overlaps1(pMinZ, pMaxZ, c.min.z, c.max.z)) continue;
    if (delta > 0) pos[axis] = (axis === 'x' ? c.min.x : c.min.z) - half - MOVE_DEFAULTS.skin;
    else pos[axis] = (axis === 'x' ? c.max.x : c.max.z) + half + MOVE_DEFAULTS.skin;
    blocked = true;
    if (out) out.collider = c;
  }
  return blocked;
}

/**
 * Highest supporting surface anywhere under the actor's footprint.
 *
 * Sampling only the centre point misses a ledge the actor is standing half on,
 * which is exactly the case a step-up needs to detect: when you walk into a kerb,
 * your centre is still short of it and only your leading edge overlaps.
 */
function groundUnderBox(world, x, z, half, fromY, tol) {
  let best = world.groundAt(x, z, fromY, tol);
  const e = half * 0.98;
  const corners = [[-e, -e], [e, -e], [-e, e], [e, e]];
  for (let i = 0; i < 4; i++) {
    const g = world.groundAt(x + corners[i][0], z + corners[i][1], fromY, tol);
    if (!g) continue;
    // Ramps are continuous surfaces, so only their centre sample counts: taking the
    // maximum across the footprint would float the actor above an incline by up to
    // radius * tan(slope). Discrete platforms do get footprint support, which is
    // what keeps you standing on the lip of a crate instead of sliding off it.
    if (g.collider.kind === RAMP) continue;
    if (!best || g.y > best.y) best = g;
  }
  return best;
}

/**
 * Collide-and-slide for an axis-aligned character box.
 *
 * Horizontal movement is resolved per axis (so blocking on X still allows Z — that is
 * the "slide"), then vertical. When a horizontal axis is blocked and the obstruction
 * is a low ledge, a step-up is attempted before giving up, which is what lets the
 * player walk stairs and kerbs without losing speed.
 *
 * @returns {{grounded:boolean, hitWall:boolean, hitCeiling:boolean, groundSurface:string, steppedUp:number, landedSpeed:number}}
 */
export function moveAndSlide(world, state, dt, cfg = MOVE_DEFAULTS) {
  const pos = state.pos;
  const vel = state.vel;
  const half = cfg.radius;
  const height = state.height ?? cfg.height;

  const res = {
    grounded: false,
    hitWall: false,
    hitCeiling: false,
    groundSurface: SURFACE.CONCRETE,
    groundCollider: null,
    steppedUp: 0,
    landedSpeed: 0,
  };

  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const travel = speed * dt;
  const steps = clamp(Math.ceil(travel / (half * 0.75)), 1, 8);
  const sdt = dt / steps;
  const scratch = { collider: null };

  for (let s = 0; s < steps; s++) {
    // ---- horizontal ----
    const dx = vel.x * sdt;
    const dz = vel.z * sdt;
    const preX = pos.x, preZ = pos.z, preY = pos.y;

    const blockedX = resolveAxis(world, pos, half, height, 'x', dx, scratch);
    const blockedZ = resolveAxis(world, pos, half, height, 'z', dz, scratch);

    if ((blockedX || blockedZ) && state.grounded) {
      // Try to step over the obstruction rather than stopping dead against it.
      const testY = preY + cfg.stepHeight;
      const headroomOk = !world.overlapsSolid(
        preX + dx - half, testY + 0.02, preZ + dz - half,
        preX + dx + half, testY + height, preZ + dz + half,
      );
      if (headroomOk) {
        const trial = { x: preX, y: testY, z: preZ };
        const bX = resolveAxis(world, trial, half, height, 'x', dx, scratch);
        const bZ = resolveAxis(world, trial, half, height, 'z', dz, scratch);
        if (!bX && !bZ) {
          const g = groundUnderBox(world, trial.x, trial.z, half, testY + 0.02, 0.02);
          if (g && g.y - preY <= cfg.stepHeight + 0.01 && g.y > preY + 0.005) {
            pos.x = trial.x;
            pos.z = trial.z;
            pos.y = g.y;
            res.steppedUp = g.y - preY;
          }
        }
      }
    }
    res.hitWall = res.hitWall || blockedX || blockedZ;

    // ---- vertical ----
    const yBeforeMove = pos.y;
    const dy = vel.y * sdt;
    pos.y += dy;

    // Ceiling
    const cMin = pos.y + 0.02, cMax = pos.y + height;
    const upHits = world.query(pos.x - half, cMin, pos.z - half, pos.x + half, cMax, pos.z + half);
    for (let i = 0; i < upHits.length; i++) {
      const c = upHits[i];
      if (c.kind !== SOLID) continue;
      if (vel.y > 0 && c.min.y >= pos.y + height * 0.5) {
        pos.y = c.min.y - height - cfg.skin;
        vel.y = 0;
        res.hitCeiling = true;
      }
    }

    // Ground.
    //
    // The probe starts from the *higher* of the pre- and post-move heights. Probing
    // from the post-move height alone means that once a fast fall has already passed
    // below a surface within the substep, that surface is no longer a candidate and
    // the actor tunnels straight through the world — this is the swept form.
    const snap = state.grounded ? cfg.groundSnap : 0.02;
    const g = groundUnderBox(
      world, pos.x, pos.z, half, Math.max(pos.y, yBeforeMove) + snap, 0.02,
    );
    if (g && vel.y <= 0.001 && pos.y <= g.y + snap) {
      if (g.collider.kind === RAMP && g.collider.slopeDeg > cfg.slopeLimitDeg) {
        // Too steep to stand on: keep falling, but do not sink through.
        if (pos.y < g.y) pos.y = g.y;
      } else {
        if (!state.grounded) res.landedSpeed = -vel.y;
        pos.y = g.y;
        vel.y = 0;
        res.grounded = true;
        res.groundSurface = g.collider.surface;
        res.groundCollider = g.collider;
      }
    }
  }

  // Final push-out in case a step landed us inside geometry (never leave the player
  // embedded — that is the failure mode that produces fall-through-world bugs).
  const embedded = world.query(
    pos.x - half, pos.y + 0.05, pos.z - half,
    pos.x + half, pos.y + height, pos.z + half,
  );
  for (let i = 0; i < embedded.length; i++) {
    const c = embedded[i];
    if (c.kind !== SOLID) continue;
    const options = [
      { a: 'x', d: c.max.x - (pos.x - half), s: 1 },
      { a: 'x', d: (pos.x + half) - c.min.x, s: -1 },
      { a: 'z', d: c.max.z - (pos.z - half), s: 1 },
      { a: 'z', d: (pos.z + half) - c.min.z, s: -1 },
    ];
    // A vertical escape is only offered for surfaces the actor could have stepped
    // onto anyway. Without this guard, standing under a low ceiling picks the
    // shortest axis and shoves the player up through it and onto the roof.
    if (c.max.y - pos.y <= cfg.stepHeight + 0.05) {
      options.push({ a: 'y', d: c.max.y - (pos.y + 0.05), s: 1 });
    }
    const pen = options.filter((p) => p.d > 0).sort((p, q) => p.d - q.d)[0];
    if (pen) pos[pen.a] += pen.d * pen.s + cfg.skin;
  }

  state.grounded = res.grounded;
  return res;
}
