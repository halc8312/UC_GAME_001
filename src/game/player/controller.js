import { clamp, damp, DEG, moveTowards } from '../../core/mathx.js';
import { moveAndSlide, SURFACE } from '../level/collision.js';

/** Tuning values are the contract in GAME_SPEC §4.1 — unit tests assert against them. */
export const MOVE = {
  walkSpeed: 5.2,
  sprintSpeed: 8.0,
  crouchSpeed: 2.6,
  accelGround: 60,
  accelAir: 8,
  friction: 10,
  gravity: 22,
  jumpHeight: 1.1,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  standHeight: 1.8,
  crouchHeight: 1.0,
  standEye: 1.62,
  crouchEye: 0.85,
  crouchTime: 0.12,
  radius: 0.35,
  stepHeight: 0.45,
  slopeLimitDeg: 50,
  maxPitch: 89 * DEG,
  bobFrequency: 1.9,
  bobAmplitude: 0.045,
  landDipMax: 0.22,
};

export const JUMP_VELOCITY = Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight);

/**
 * Quake-style directional acceleration: only accelerates up to `wishSpeed` along the
 * wish direction, which gives responsive ground control and believable air control
 * without ever exceeding the intended top speed.
 */
export function accelerate(vel, wishX, wishZ, wishSpeed, accel, dt) {
  const current = vel.x * wishX + vel.z * wishZ;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * dt, add);
  vel.x += wishX * accelSpeed;
  vel.z += wishZ * accelSpeed;
}

export function applyFriction(vel, friction, dt) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 0.001) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const drop = speed * friction * dt;
  const scale = Math.max(0, speed - drop) / speed;
  vel.x *= scale;
  vel.z *= scale;
}

export class PlayerController {
  constructor(world, opts = {}) {
    this.world = world;
    this.cfg = { ...MOVE, ...opts };

    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;

    this.grounded = false;
    this.wasGrounded = false;
    this.crouching = false;
    this.sprinting = false;
    this.height = this.cfg.standHeight;
    this.eyeHeight = this.cfg.standEye;

    this.coyote = 0;
    this.jumpBuffered = 0;
    this.crouchT = 0;           // 0 = standing, 1 = fully crouched
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.groundSurface = SURFACE.CONCRETE;
    this.distanceTravelled = 0;
    this.stepDistance = 0;      // accumulates for footstep triggering
    this.lastLandSpeed = 0;
    this.speed = 0;
    this.frozen = false;

    // Recoil / hit view punch, owned by other systems but applied to the camera here.
    this.viewPunch = { x: 0, y: 0 };
    this.viewPunchVel = { x: 0, y: 0 };

    this._state = { pos: this.pos, vel: this.vel, height: this.height, grounded: false };
  }

  setPosition(x, y, z) {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.grounded = false;
    return this;
  }

  addViewPunch(pitchRad, yawRad) {
    this.viewPunchVel.x += pitchRad;
    this.viewPunchVel.y += yawRad;
  }

  /** Look input is applied outside the fixed step budget so it never feels laggy. */
  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -this.cfg.maxPitch, this.cfg.maxPitch);
  }

  canStand() {
    const c = this.cfg;
    return !this.world.overlapsSolid(
      this.pos.x - c.radius, this.pos.y + 0.05, this.pos.z - c.radius,
      this.pos.x + c.radius, this.pos.y + c.standHeight, this.pos.z + c.radius,
    );
  }

  /**
   * One fixed simulation step.
   * @param {object} cmd command frame from Input
   * @param {number} dt fixed timestep
   * @param {object} [mods] {speedScale, aiming}
   */
  update(cmd, dt, mods = {}) {
    const c = this.cfg;
    if (this.frozen) {
      this.speed = 0;
      return { grounded: this.grounded, steppedUp: 0, landed: false };
    }

    this.look(cmd.lookX, cmd.lookY);

    // ---- stance ----
    const wantCrouch = cmd.crouch;
    if (!wantCrouch && this.crouching && !this.canStand()) {
      // Blocked overhead: stay crouched until there is headroom.
    } else {
      this.crouching = wantCrouch;
    }
    this.crouchT = moveTowards(this.crouchT, this.crouching ? 1 : 0, dt / c.crouchTime);
    this.height = c.standHeight + (c.crouchHeight - c.standHeight) * this.crouchT;

    // ---- wish direction ----
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // yaw 0 faces -Z; forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    let wishX = -sin * cmd.moveZ + cos * cmd.moveX;
    let wishZ = -cos * cmd.moveZ - sin * cmd.moveX;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 0.0001) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    this.sprinting =
      cmd.sprint && cmd.moveZ > 0 && !this.crouching && !mods.aiming && wishLen > 0.1;

    let wishSpeed = this.crouching
      ? c.crouchSpeed
      : this.sprinting
        ? c.sprintSpeed
        : c.walkSpeed;
    if (wishLen < 0.0001) wishSpeed = 0;
    wishSpeed *= mods.speedScale ?? 1;

    // ---- horizontal integration ----
    if (this.grounded) {
      if (wishSpeed > 0) {
        // Friction is reduced while the player is actively driving.
        //
        // At full strength it fights the input: the equilibrium speed of
        // "friction then accelerate" is accelGround / friction = 6 m/s, which makes
        // the spec's 8 m/s sprint physically unreachable no matter how long you
        // hold the key. Reduced friction keeps direction changes crisp while the
        // clamp below enforces the stance's top speed exactly.
        applyFriction(this.vel, c.friction * 0.35, dt);
        accelerate(this.vel, wishX, wishZ, wishSpeed, c.accelGround, dt);
        const sp = Math.hypot(this.vel.x, this.vel.z);
        if (sp > wishSpeed) {
          const k = wishSpeed / sp;
          this.vel.x *= k;
          this.vel.z *= k;
        }
      } else {
        applyFriction(this.vel, c.friction, dt);
      }
    } else {
      accelerate(this.vel, wishX, wishZ, wishSpeed, c.accelAir, dt);
    }

    // ---- jump ----
    this.coyote = this.grounded ? c.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffered = cmd.jump ? c.jumpBuffer : Math.max(0, this.jumpBuffered - dt);
    let jumped = false;
    if (this.jumpBuffered > 0 && this.coyote > 0 && !this.crouching) {
      this.vel.y = JUMP_VELOCITY;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffered = 0;
      jumped = true;
    }

    // ---- gravity ----
    if (!this.grounded) this.vel.y -= c.gravity * dt;
    else if (this.vel.y < 0) this.vel.y = 0;

    // ---- collide & slide ----
    this._state.height = this.height;
    this._state.grounded = this.grounded;
    const before = { x: this.pos.x, z: this.pos.z };
    const r = moveAndSlide(this.world, this._state, dt, {
      radius: c.radius,
      height: this.height,
      stepHeight: c.stepHeight,
      slopeLimitDeg: c.slopeLimitDeg,
      skin: 0.001,
      groundSnap: 0.28,
    });

    this.wasGrounded = this.grounded;
    this.grounded = r.grounded;
    this.groundSurface = r.groundSurface;

    const landed = !this.wasGrounded && this.grounded;
    if (landed) {
      this.lastLandSpeed = r.landedSpeed;
      this.landDipVel -= Math.min(c.landDipMax, r.landedSpeed * 0.022);
    }

    // ---- derived motion state ----
    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.distanceTravelled += moved;
    this.stepDistance += this.grounded ? moved : 0;
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // ---- view feel ----
    const bobTarget = this.grounded ? clamp(this.speed / c.walkSpeed, 0, 1.4) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 8, dt);
    if (this.grounded) this.bobPhase += moved * c.bobFrequency;

    // Critically damped spring back to neutral for the landing dip.
    const k = 220, d = 22;
    this.landDipVel += (-k * this.landDip - d * this.landDipVel) * dt;
    this.landDip += this.landDipVel * dt;
    this.landDip = clamp(this.landDip, -0.5, 0.2);

    this.viewPunch.x += this.viewPunchVel.x * dt;
    this.viewPunch.y += this.viewPunchVel.y * dt;
    this.viewPunchVel.x = damp(this.viewPunchVel.x, 0, 14, dt);
    this.viewPunchVel.y = damp(this.viewPunchVel.y, 0, 14, dt);
    this.viewPunch.x = damp(this.viewPunch.x, 0, 9, dt);
    this.viewPunch.y = damp(this.viewPunch.y, 0, 9, dt);

    this.eyeHeight = c.standEye + (c.crouchEye - c.standEye) * this.crouchT;

    return {
      grounded: this.grounded,
      jumped,
      landed,
      landSpeed: r.landedSpeed,
      steppedUp: r.steppedUp,
      hitWall: r.hitWall,
      moved,
    };
  }

  /** Camera offsets for the render step (bob, dip, punch). Not part of simulation. */
  cameraOffset(out = { x: 0, y: 0, z: 0 }, bobEnabled = true, adsFactor = 0) {
    const c = this.cfg;
    const amp = bobEnabled ? c.bobAmplitude * this.bobAmount * (1 - 0.8 * adsFactor) : 0;
    out.x = Math.sin(this.bobPhase) * amp * 0.7;
    out.y = Math.abs(Math.sin(this.bobPhase * 1.0)) * -amp + this.landDip;
    out.z = 0;
    return out;
  }

  /** Consumes accumulated step distance; returns true when a footstep should play. */
  takeFootstep(strideLength) {
    if (this.stepDistance >= strideLength) {
      this.stepDistance = 0;
      return true;
    }
    return false;
  }

  get eyePosition() {
    return { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
  }

  /** Unit forward vector from yaw+pitch, written into `out`. */
  forward(out = { x: 0, y: 0, z: 0 }) {
    const cp = Math.cos(this.pitch);
    out.x = -Math.sin(this.yaw) * cp;
    out.y = Math.sin(this.pitch);
    out.z = -Math.cos(this.yaw) * cp;
    return out;
  }
}
