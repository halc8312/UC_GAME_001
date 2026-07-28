import { clamp, clamp01, planarDist, v3 } from '../../core/mathx.js';
import { PlayerController } from './controller.js';
import {
  addArmor, applyDamage, damageDirection, fallDamage, heal, hitboxesFor, rayHitboxes,
} from '../combat/damage.js';

export const PLAYER = {
  maxHp: 100,
  maxArmor: 100,
  interactRange: 2.6,
  strideWalk: 2.1,
  strideSprint: 2.6,
  strideCrouch: 2.6,
  regenDelay: 7.0,      // seconds out of combat before chip regen starts
  regenRate: 6.0,       // hp/second, only back up to the segment ceiling
  regenCeiling: 45,     // never regenerates past this — pickups do the rest
  damageIndicatorTime: 2.2,
};

/**
 * The player: movement, vitals, interaction, and everything that feeds the HUD.
 * Rendering and input live outside; this is the simulation-side player.
 */
export class Player {
  constructor(ctx) {
    this.ctx = ctx; // {world, bus, rng}
    this.controller = new PlayerController(ctx.world);
    this.hp = PLAYER.maxHp;
    this.armor = 0;
    this.dead = false;
    this.timeSinceDamage = 999;
    this.firingRecently = false;
    this._fireTimer = 0;

    this.interactTarget = null;
    this.interactHoldT = 0;
    this.damageIndicators = [];
    this.hitboxes = [];

    this.stats = {
      damageTaken: 0,
      damageDealt: 0,
      deaths: 0,
      pickups: 0,
      distance: 0,
    };
  }

  get pos() {
    return this.controller.pos;
  }

  get speed() {
    return this.controller.speed;
  }

  get height() {
    return this.controller.height;
  }

  get yaw() {
    return this.controller.yaw;
  }

  get eye() {
    return this.controller.eyePosition;
  }

  get crouchFactor() {
    return this.controller.crouchT;
  }

  reset(spawn) {
    this.controller.setPosition(spawn.x, spawn.y, spawn.z);
    this.controller.yaw = spawn.yaw ?? 0;
    this.controller.pitch = 0;
    this.controller.viewPunch.x = this.controller.viewPunch.y = 0;
    this.controller.viewPunchVel.x = this.controller.viewPunchVel.y = 0;
    this.controller.landDip = 0;
    this.controller.landDipVel = 0;
    this.controller.frozen = false;
    this.hp = PLAYER.maxHp;
    this.armor = 0;
    this.dead = false;
    this.timeSinceDamage = 999;
    this.damageIndicators.length = 0;
    this.interactTarget = null;
    this.interactHoldT = 0;
    return this;
  }

  takeDamage(amount, info = {}) {
    if (this.dead) return { killed: false, dealt: 0 };
    const res = applyDamage(this, amount);
    this.stats.damageTaken += res.dealt;
    this.timeSinceDamage = 0;

    if (info.fromX !== undefined) {
      const angle = damageDirection(
        this.controller.yaw, this.pos.x, this.pos.z, info.fromX, info.fromZ,
      );
      this.damageIndicators.push({ angle, life: PLAYER.damageIndicatorTime });
      // Punch the view away from the hit so getting shot is felt, not just seen.
      this.controller.addViewPunch(-0.5 * clamp01(res.dealt / 25), Math.sin(angle) * 0.35);
    }

    this.ctx.bus.emit('player:damaged', {
      amount: res.dealt, hp: this.hp, armor: this.armor,
      fromX: info.fromX, fromZ: info.fromZ, source: info.source,
    });

    if (res.killed) {
      this.dead = true;
      this.stats.deaths++;
      this.controller.frozen = true;
      this.ctx.bus.emit('player:died', { cause: info.source || 'gunfire' });
    }
    return res;
  }

  addHealth(amount) {
    const given = heal(this, amount, PLAYER.maxHp);
    if (given > 0) this.stats.pickups++;
    return given;
  }

  addArmor(amount) {
    const given = addArmor(this, amount, PLAYER.maxArmor);
    if (given > 0) this.stats.pickups++;
    return given;
  }

  /** Raycast against the player's own hitboxes — used by enemy fire resolution. */
  testShot(ox, oy, oz, dx, dy, dz, maxDist) {
    if (this.dead) return null;
    hitboxesFor(this.pos, this.hitboxes, this.controller.crouchT);
    const h = rayHitboxes(ox, oy, oz, dx, dy, dz, maxDist, this.hitboxes);
    return h.hit ? h : null;
  }

  /** Nearest interactable in front of the player, within range and line of sight. */
  _findInteractable(interactables) {
    const eye = this.eye;
    const f = this.controller.forward();
    let best = null;
    let bestScore = -1;
    for (const it of interactables) {
      if (it.disabled) continue;
      const dx = it.x - eye.x;
      const dy = it.y - eye.y;
      const dz = it.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > PLAYER.interactRange) continue;
      const dot = (dx * f.x + dy * f.y + dz * f.z) / (dist || 1);
      if (dot < 0.55) continue;
      const score = dot - dist * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    return best;
  }

  update(cmd, dt, ctxIn) {
    const c = this.controller;

    if (this.dead) {
      // Death camera: slump and keep rendering the world.
      c.eyeHeight = Math.max(0.42, c.eyeHeight - dt * 2.4);
      for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
        this.damageIndicators[i].life -= dt;
        if (this.damageIndicators[i].life <= 0) this.damageIndicators.splice(i, 1);
      }
      return { landed: false, jumped: false };
    }

    const r = c.update(cmd, dt, {
      aiming: ctxIn.aiming,
      speedScale: ctxIn.speedScale ?? 1,
    });

    this.stats.distance += r.moved;

    // ---- fall damage ----
    if (r.landed && r.landSpeed > 0) {
      const dmg = fallDamage(r.landSpeed);
      if (dmg > 0) {
        this.takeDamage(dmg, { source: 'fall' });
      }
      this.ctx.bus.emit('player:land', {
        speed: r.landSpeed, surface: c.groundSurface, hard: r.landSpeed > 9,
      });
    }
    if (r.jumped) this.ctx.bus.emit('player:jump', { surface: c.groundSurface });

    // ---- footsteps ----
    const stride = c.crouching
      ? PLAYER.strideCrouch
      : c.sprinting ? PLAYER.strideSprint : PLAYER.strideWalk;
    if (c.grounded && c.speed > 0.7 && c.takeFootstep(stride)) {
      this.ctx.bus.emit('player:footstep', {
        surface: c.groundSurface,
        loud: c.sprinting,
        x: this.pos.x, y: this.pos.y, z: this.pos.z,
      });
    }

    // ---- regen ----
    this.timeSinceDamage += dt;
    if (
      this.timeSinceDamage > PLAYER.regenDelay &&
      this.hp < PLAYER.regenCeiling
    ) {
      this.hp = Math.min(PLAYER.regenCeiling, this.hp + PLAYER.regenRate * dt);
    }

    // ---- fire recency (feeds enemy perception) ----
    if (ctxIn.firedThisStep) this._fireTimer = 1.2;
    this._fireTimer = Math.max(0, this._fireTimer - dt);
    this.firingRecently = this._fireTimer > 0;

    // ---- damage indicators ----
    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      this.damageIndicators[i].life -= dt;
      if (this.damageIndicators[i].life <= 0) this.damageIndicators.splice(i, 1);
    }

    // ---- interaction ----
    const target = this._findInteractable(ctxIn.interactables || []);
    if (target !== this.interactTarget) {
      this.interactTarget = target;
      this.interactHoldT = 0;
    }
    if (target) {
      const holdTime = target.holdTime || 0;
      if (holdTime > 0) {
        if (cmd.interactHeld) {
          if (this.interactHoldT === 0) {
            this.ctx.bus.emit('interact:start', { id: target.id });
          }
          this.interactHoldT += dt;
          if (this.interactHoldT >= holdTime) {
            this.interactHoldT = 0;
            this.ctx.bus.emit('interact:complete', { id: target.id, target });
          }
        } else if (this.interactHoldT > 0) {
          this.interactHoldT = 0;
          this.ctx.bus.emit('interact:cancel', { id: target.id });
        }
      } else if (cmd.interact) {
        this.ctx.bus.emit('interact:complete', { id: target.id, target });
      }
    }

    return r;
  }

  get interactProgress() {
    const t = this.interactTarget;
    if (!t || !t.holdTime) return 0;
    return clamp01(this.interactHoldT / t.holdTime);
  }
}
