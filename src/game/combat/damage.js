import { clamp } from '../../core/mathx.js';

export const HITBOX = { HEAD: 'head', TORSO: 'torso', LIMB: 'limb' };

/**
 * Hitbox layout for a 1.8 m humanoid, expressed as offsets from the feet position.
 * These are axis-aligned rather than oriented: at this character scale the error is
 * under ~8 cm on the torso and the head box is nearly square in plan, so the
 * simplification is invisible in play and keeps hit resolution allocation-free.
 */
export const HUMANOID_BOXES = [
  { kind: HITBOX.HEAD, dx: 0.14, y0: 1.54, y1: 1.79, dz: 0.14 },
  { kind: HITBOX.TORSO, dx: 0.26, y0: 0.92, y1: 1.54, dz: 0.18 },
  { kind: HITBOX.LIMB, dx: 0.44, y0: 0.92, y1: 1.5, dz: 0.16 },  // arms
  { kind: HITBOX.LIMB, dx: 0.22, y0: 0.0, y1: 0.92, dz: 0.16 },  // legs
];

/** Order matters: head is tested first so a head/arm overlap resolves as a head shot. */
export function hitboxesFor(pos, out = [], crouchFactor = 0) {
  out.length = 0;
  const squash = 1 - 0.42 * clamp(crouchFactor, 0, 1);
  for (let i = 0; i < HUMANOID_BOXES.length; i++) {
    const b = HUMANOID_BOXES[i];
    out.push({
      kind: b.kind,
      minX: pos.x - b.dx, maxX: pos.x + b.dx,
      minY: pos.y + b.y0 * squash, maxY: pos.y + b.y1 * squash,
      minZ: pos.z - b.dz, maxZ: pos.z + b.dz,
    });
  }
  return out;
}

const _res = { hit: false, kind: '', dist: 0, x: 0, y: 0, z: 0 };

/** Slab test against a list of hitboxes; returns the nearest hit (shared result object). */
export function rayHitboxes(ox, oy, oz, dx, dy, dz, maxDist, boxes) {
  _res.hit = false;
  _res.dist = maxDist;
  _res.kind = '';
  const invX = dx !== 0 ? 1 / dx : Infinity;
  const invY = dy !== 0 ? 1 / dy : Infinity;
  const invZ = dz !== 0 ? 1 / dz : Infinity;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let tmin = 0;
    let tmax = maxDist;

    let t1 = (b.minX - ox) * invX, t2 = (b.maxX - ox) * invX;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) continue;

    t1 = (b.minY - oy) * invY; t2 = (b.maxY - oy) * invY;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) continue;

    t1 = (b.minZ - oz) * invZ; t2 = (b.maxZ - oz) * invZ;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) continue;

    if (tmin >= 0 && tmin < _res.dist) {
      _res.hit = true;
      _res.dist = tmin;
      _res.kind = b.kind;
      _res.x = ox + dx * tmin;
      _res.y = oy + dy * tmin;
      _res.z = oz + dz * tmin;
    } else if (tmin < 0 && tmax > 0 && !_res.hit) {
      // Origin inside the box (point-blank): count it at zero distance.
      _res.hit = true;
      _res.dist = 0;
      _res.kind = b.kind;
      _res.x = ox; _res.y = oy; _res.z = oz;
    }
  }
  return _res;
}

/**
 * Health/armour model. Armour soaks a fraction of incoming damage and is consumed
 * doing so, which makes armour pickups feel like a real reprieve without making the
 * player invulnerable.
 */
export const ARMOR_ABSORB = 0.55;

export function applyDamage(target, amount, opts = {}) {
  const result = { dealt: 0, absorbed: 0, killed: false, overkill: 0 };
  if (target.dead || amount <= 0) return result;

  let remaining = amount;
  if (!opts.ignoreArmor && target.armor > 0) {
    const soak = Math.min(target.armor, remaining * ARMOR_ABSORB);
    target.armor = Math.max(0, target.armor - soak);
    remaining -= soak;
    result.absorbed = soak;
  }
  const before = target.hp;
  target.hp = Math.max(0, target.hp - remaining);
  result.dealt = before - target.hp;
  if (target.hp <= 0) {
    target.dead = true;
    result.killed = true;
    result.overkill = remaining - result.dealt;
  }
  return result;
}

export function heal(target, amount, maxHp) {
  const before = target.hp;
  target.hp = Math.min(maxHp, target.hp + amount);
  return target.hp - before;
}

export function addArmor(target, amount, maxArmor) {
  const before = target.armor;
  target.armor = Math.min(maxArmor, target.armor + amount);
  return target.armor - before;
}

/** Damage taken from a fall, in the classic "free below a threshold" shape. */
export function fallDamage(impactSpeed, safeSpeed = 9, lethalSpeed = 26) {
  if (impactSpeed <= safeSpeed) return 0;
  const t = clamp((impactSpeed - safeSpeed) / (lethalSpeed - safeSpeed), 0, 1);
  return Math.round(t * t * 100);
}

/** Screen-space angle (radians) of an incoming hit relative to the player's facing. */
export function damageDirection(playerYaw, playerX, playerZ, sourceX, sourceZ) {
  const worldAngle = Math.atan2(sourceX - playerX, -(sourceZ - playerZ));
  let rel = worldAngle - playerYaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  return rel;
}
