import { clamp, clamp01, damp, DEG, moveTowards } from '../../core/mathx.js';
import { WEAPONS } from './weapondefs.js';
import {
  applySpreadToDirection,
  currentSpread,
  damageForHit,
  decaySpread,
  makeBallisticState,
  pelletDirections,
  recoilForShot,
  registerShot,
  rpmToInterval,
  updateRecoil,
} from './ballistics.js';
import { hitboxesFor, rayHitboxes } from '../combat/damage.js';

export const WEAPON_STATE = {
  READY: 'ready',
  FIRING: 'firing',
  RELOADING: 'reloading',
  PUMPING: 'pumping',
  SWITCHING: 'switching',
};

/** Per-weapon mutable runtime state. */
function makeSlot(def) {
  return {
    def,
    id: def.id,
    mag: def.magazineSize,
    reserve: def.reserveAmmo,
    ballistics: makeBallisticState(),
    shotsFired: 0,
    shotsHit: 0,
    kills: 0,
  };
}

/**
 * Runtime weapon system: fire timing, ammo, reload, ADS, weapon switching, and
 * hitscan resolution against both the level and enemy hitboxes.
 *
 * Emits (via the shared bus): `weapon:fire`, `weapon:impact`, `weapon:hit`,
 * `weapon:reload`, `weapon:dry`, `weapon:switch`, `weapon:tracer`.
 */
export class WeaponSystem {
  /**
   * @param {object} deps {world, rng, bus, targets:() => Array, audio}
   */
  constructor(deps) {
    this.world = deps.world;
    this.rng = deps.rng;
    this.bus = deps.bus;
    this.targets = deps.targets || (() => []);

    this.slots = [makeSlot(WEAPONS.rifle)];
    this.owned = new Set(['rifle']);
    this.index = 0;
    this.state = WEAPON_STATE.READY;
    this.stateTime = 0;
    this.cooldown = 0;
    this.adsFactor = 0;
    this.aiming = false;
    this.reloadTotal = 0;
    this.pendingShells = 0;
    this.lastFireTime = -99;
    this.time = 0;
    this.burstShots = 0;

    // Scratch objects; the fire path must not allocate.
    this._dir = { x: 0, y: 0, z: 0 };
    this._right = { x: 0, y: 0, z: 0 };
    this._up = { x: 0, y: 0, z: 0 };
    this._pellets = [];
    this._boxes = [];
    this._hitResult = {
      kind: '', dist: 0, x: 0, y: 0, z: 0, target: null, surface: 'concrete',
      normalX: 0, normalY: 1, normalZ: 0,
    };

    this.stats = { shotsFired: 0, shotsHit: 0, pelletsFired: 0, pelletsHit: 0, kills: 0, headshots: 0 };
  }

  get slot() {
    return this.slots[this.index];
  }

  get def() {
    return this.slot.def;
  }

  get magAmmo() {
    return this.slot.mag;
  }

  get reserveAmmo() {
    return this.slot.reserve;
  }

  get busy() {
    return this.state === WEAPON_STATE.RELOADING || this.state === WEAPON_STATE.SWITCHING ||
      this.state === WEAPON_STATE.PUMPING;
  }

  /** Fraction 0..1 of the current reload/pump, for the HUD bar. */
  get actionProgress() {
    if (this.reloadTotal <= 0) return 0;
    return clamp01(this.stateTime / this.reloadTotal);
  }

  get spreadDeg() {
    return this.slot.ballistics.spread;
  }

  grant(id) {
    if (this.owned.has(id)) {
      // Already owned: top up reserve instead of duplicating the slot.
      const s = this.slots.find((x) => x.id === id);
      if (s) s.reserve = Math.min(s.def.reserveAmmo, s.reserve + Math.ceil(s.def.reserveAmmo * 0.5));
      return false;
    }
    const def = WEAPONS[id];
    if (!def) return false;
    this.owned.add(id);
    this.slots.push(makeSlot(def));
    return true;
  }

  switchTo(index) {
    if (index < 0 || index >= this.slots.length || index === this.index) return false;
    if (this.state === WEAPON_STATE.SWITCHING) return false;
    this._pendingIndex = index;
    this.state = WEAPON_STATE.SWITCHING;
    this.stateTime = 0;
    this.reloadTotal = this.def.switchTime;
    this.bus.emit('weapon:switch', { from: this.slot.id, to: this.slots[index].id });
    return true;
  }

  startReload() {
    const s = this.slot;
    if (s.mag >= s.def.magazineSize || s.reserve <= 0) return false;
    if (this.state === WEAPON_STATE.RELOADING || this.state === WEAPON_STATE.SWITCHING) return false;
    this.state = WEAPON_STATE.RELOADING;
    this.stateTime = 0;
    if (s.def.reloadType === 'shell') {
      this.reloadTotal = s.def.shellReloadTime;
      this.bus.emit('weapon:reload', { id: s.id, stage: 'shell_start' });
    } else {
      this.reloadTotal = s.mag > 0 ? s.def.reloadTacticalTime : s.def.reloadTime;
      this.bus.emit('weapon:reload', { id: s.id, stage: 'start', tactical: s.mag > 0 });
    }
    return true;
  }

  cancelReload() {
    if (this.state !== WEAPON_STATE.RELOADING) return false;
    this.state = WEAPON_STATE.READY;
    this.stateTime = 0;
    return true;
  }

  /**
   * @param {object} cmd input command frame
   * @param {number} dt fixed timestep
   * @param {object} ctx {eye:{x,y,z}, forward:{x,y,z}, yaw, pitch, speed, crouched, grounded, onFire}
   */
  update(cmd, dt, ctx) {
    this.time += dt;
    this.stateTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // ---- aim down sights ----
    const wantAds = cmd.aim && this.state !== WEAPON_STATE.RELOADING &&
      this.state !== WEAPON_STATE.SWITCHING;
    this.aiming = wantAds;
    const adsSpeed = 1 / Math.max(0.05, this.def.adsTime);
    this.adsFactor = moveTowards(this.adsFactor, wantAds ? 1 : 0, dt * adsSpeed);

    // ---- state machine ----
    switch (this.state) {
      case WEAPON_STATE.SWITCHING:
        if (this.stateTime >= this.reloadTotal) {
          this.index = this._pendingIndex ?? this.index;
          this._pendingIndex = null;
          this.state = WEAPON_STATE.READY;
          this.stateTime = 0;
          this.cooldown = 0.05;
        }
        break;

      case WEAPON_STATE.RELOADING:
        if (this.def.reloadType === 'shell') {
          if (this.stateTime >= this.reloadTotal) {
            const s = this.slot;
            const take = Math.min(1, s.reserve, s.def.magazineSize - s.mag);
            s.mag += take;
            s.reserve -= take;
            this.stateTime = 0;
            this.bus.emit('weapon:reload', { id: s.id, stage: 'shell' });
            if (s.mag >= s.def.magazineSize || s.reserve <= 0) {
              this.state = WEAPON_STATE.PUMPING;
              this.reloadTotal = s.def.pumpTime;
              this.stateTime = 0;
              this.bus.emit('weapon:reload', { id: s.id, stage: 'end' });
            } else if (cmd.fire && s.mag > 0) {
              // Shell reloads are interruptible: firing cuts them short.
              this.state = WEAPON_STATE.READY;
              this.stateTime = 0;
            }
          }
        } else if (this.stateTime >= this.reloadTotal) {
          const s = this.slot;
          const need = s.def.magazineSize - s.mag;
          const take = Math.min(need, s.reserve);
          s.mag += take;
          s.reserve -= take;
          this.state = WEAPON_STATE.READY;
          this.stateTime = 0;
          this.bus.emit('weapon:reload', { id: s.id, stage: 'end' });
        }
        break;

      case WEAPON_STATE.PUMPING:
        if (this.stateTime >= this.reloadTotal) {
          this.state = WEAPON_STATE.READY;
          this.stateTime = 0;
        }
        break;

      default:
        this.state = WEAPON_STATE.READY;
    }

    // ---- input ----
    if (cmd.slot >= 0 && cmd.slot < this.slots.length) this.switchTo(cmd.slot);
    if (cmd.nextWeapon) {
      const n = (this.index + (cmd.nextWeapon > 0 ? 1 : -1) + this.slots.length) % this.slots.length;
      this.switchTo(n);
    }
    if (cmd.reload) this.startReload();

    const wantFire = this.def.fireMode === 'auto' ? cmd.fire : cmd.firePressed;
    if (wantFire && !this.busy && this.cooldown <= 0) {
      if (this.slot.mag > 0) {
        this._fire(ctx);
      } else if (cmd.firePressed) {
        this.bus.emit('weapon:dry', { id: this.slot.id });
        this.cooldown = 0.25;
        if (this.slot.reserve > 0) this.startReload();
      }
    }

    // Auto-reload when the magazine runs dry and the trigger is released.
    if (this.slot.mag === 0 && this.slot.reserve > 0 && !this.busy && !cmd.fire) {
      this.startReload();
    }

    // ---- spread / recoil recovery ----
    const s = this.slot;
    decaySpread(s.ballistics, s.def, dt);
    updateRecoil(s.ballistics, s.def, dt);
    if (this.time - this.lastFireTime > 0.4) this.burstShots = 0;
  }

  _fire(ctx) {
    const s = this.slot;
    const def = s.def;
    s.mag--;
    s.shotsFired++;
    this.stats.shotsFired++;
    this.cooldown = rpmToInterval(def.rpm);
    this.lastFireTime = this.time;
    this.burstShots++;

    const moving = ctx.speed > 0.8;
    const spread = currentSpread(
      s.ballistics, def, this.adsFactor, moving, ctx.crouched, !ctx.grounded,
    );

    // Camera basis for cone sampling.
    const f = ctx.forward;
    this._right.x = -f.z;
    this._right.y = 0;
    this._right.z = f.x;
    const rl = Math.hypot(this._right.x, this._right.z) || 1;
    this._right.x /= rl;
    this._right.z /= rl;
    this._up.x = this._right.y * f.z - this._right.z * f.y;
    this._up.y = this._right.z * f.x - this._right.x * f.z;
    this._up.z = this._right.x * f.y - this._right.y * f.x;

    const eye = ctx.eye;
    let anyHit = false;
    let anyCrit = false;

    if (def.pellets > 1) {
      pelletDirections(this._pellets, f, this._right, this._up, def, this.rng, spread);
      for (let i = 0; i < this._pellets.length; i++) {
        this.stats.pelletsFired++;
        const r = this._resolveShot(eye, this._pellets[i], def, i === 0);
        if (r) {
          anyHit = true;
          this.stats.pelletsHit++;
          if (r.crit) anyCrit = true;
        }
      }
      if (anyHit) {
        s.shotsHit++;
        this.stats.shotsHit++;
      }
    } else {
      applySpreadToDirection(this._dir, f, this._right, this._up, spread, this.rng);
      const tracer = s.shotsFired % def.tracerEveryNShots === 0;
      const r = this._resolveShot(eye, this._dir, def, tracer);
      if (r) {
        anyHit = true;
        s.shotsHit++;
        this.stats.shotsHit++;
        if (r.crit) anyCrit = true;
      }
    }

    if (anyHit) this.bus.emit('weapon:hit', { crit: anyCrit, id: def.id });

    registerShot(s.ballistics, def);
    const kick = recoilForShot(def, this.burstShots, this.rng);
    s.ballistics.recoilPitch += kick.pitch;
    s.ballistics.recoilYaw += kick.yaw;

    const adsScale = 1 - 0.35 * this.adsFactor;
    this.bus.emit('weapon:fire', {
      id: def.id,
      mag: s.mag,
      punchPitch: kick.pitch * adsScale,
      punchYaw: kick.yaw * adsScale,
      eye,
      dir: def.pellets > 1 ? f : this._dir,
      sound: def.sounds.fire,
    });

    if (def.fireMode === 'pump' && s.mag > 0) {
      this.state = WEAPON_STATE.PUMPING;
      this.reloadTotal = def.pumpTime;
      this.stateTime = 0;
    }
  }

  /**
   * Resolve one bullet/pellet against the world and every live target.
   * @returns {null|{crit:boolean, killed:boolean}}
   */
  _resolveShot(eye, dir, def, tracer) {
    const maxDist = def.maxRangeMeters;
    const wall = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, maxDist);
    let bestDist = wall.hit ? wall.dist : maxDist;
    let bestTarget = null;
    let bestKind = '';
    let bx = 0, by = 0, bz = 0;

    const targets = this.targets();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.dead) continue;
      // Cheap reject: skip anything clearly outside the ray's reach.
      const dx = t.pos.x - eye.x, dy = t.pos.y + 0.9 - eye.y, dz = t.pos.z - eye.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (along < -1 || along > bestDist + 1.2) continue;
      const perpSq = dx * dx + dy * dy + dz * dz - along * along;
      if (perpSq > 1.6) continue;

      hitboxesFor(t.pos, this._boxes, t.crouchFactor || 0);
      const h = rayHitboxes(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, bestDist, this._boxes);
      if (h.hit && h.dist < bestDist) {
        bestDist = h.dist;
        bestTarget = t;
        bestKind = h.kind;
        bx = h.x; by = h.y; bz = h.z;
      }
    }

    if (tracer) {
      this.bus.emit('weapon:tracer', {
        x0: eye.x, y0: eye.y, z0: eye.z,
        x1: eye.x + dir.x * bestDist,
        y1: eye.y + dir.y * bestDist,
        z1: eye.z + dir.z * bestDist,
      });
    }

    if (bestTarget) {
      const dmg = damageForHit(def, bestDist, bestKind);
      const res = bestTarget.takeDamage(dmg, {
        kind: bestKind,
        fromX: eye.x, fromY: eye.y, fromZ: eye.z,
        dirX: dir.x, dirY: dir.y, dirZ: dir.z,
        weapon: def.id,
      });
      const crit = bestKind === 'head';
      if (crit) this.stats.headshots++;
      if (res && res.killed) {
        this.stats.kills++;
        this.slot.kills++;
      }
      this.bus.emit('weapon:impact', {
        x: bx, y: by, z: bz,
        nx: -dir.x, ny: -dir.y, nz: -dir.z,
        surface: 'flesh',
        crit,
      });
      return { crit, killed: !!(res && res.killed) };
    }

    if (wall.hit) {
      this.bus.emit('weapon:impact', {
        x: wall.point.x, y: wall.point.y, z: wall.point.z,
        nx: wall.normal.x, ny: wall.normal.y, nz: wall.normal.z,
        surface: wall.collider ? wall.collider.surface : 'concrete',
        crit: false,
      });
    }
    return null;
  }

  get accuracy() {
    return this.stats.shotsFired ? this.stats.shotsHit / this.stats.shotsFired : 0;
  }

  /** Total recoil offset to apply to the camera this frame. */
  recoilOffset() {
    const b = this.slot.ballistics;
    return { pitch: b.recoilPitch, yaw: b.recoilYaw };
  }

  addAmmo(amount) {
    let given = 0;
    for (const s of this.slots) {
      const room = s.def.reserveAmmo - s.reserve;
      if (room <= 0) continue;
      const share = Math.min(room, Math.ceil(amount * (s.def.magazineSize / 30)));
      s.reserve += share;
      given += share;
    }
    return given;
  }

  reset() {
    this.slots = [makeSlot(WEAPONS.rifle)];
    this.owned = new Set(['rifle']);
    this.index = 0;
    this.state = WEAPON_STATE.READY;
    this.stateTime = 0;
    this.cooldown = 0;
    this.adsFactor = 0;
    this.burstShots = 0;
    this.stats = { shotsFired: 0, shotsHit: 0, pelletsFired: 0, pelletsHit: 0, kills: 0, headshots: 0 };
  }
}
