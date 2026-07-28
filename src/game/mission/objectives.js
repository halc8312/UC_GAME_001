import { clamp01, planarDist } from '../../core/mathx.js';

export const OBJECTIVE_TYPE = {
  REACH: 'reach',
  INTERACT: 'interact',
  INTERACT_HOLD: 'interact-hold',
  SURVIVE_TIMER: 'survive-timer',
  ELIMINATE: 'eliminate',
};

export const OBJECTIVE_STATE = {
  LOCKED: 'locked',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
};

/**
 * One mission goal. Deliberately data-shaped: the director only ever reads
 * `type`/`target`/`count`, so adding an objective needs no new director code.
 */
export class Objective {
  constructor(def) {
    Object.assign(this, {
      id: def.id,
      type: def.type,
      label: def.label,
      hint: def.hint || '',
      marker: def.marker || null,
      radius: def.radius ?? 3,
      count: def.count ?? 1,
      duration: def.duration ?? 0,
      phase: def.phase || '',
      state: OBJECTIVE_STATE.LOCKED,
      progress: 0,
      elapsed: 0,
    });
  }

  get done() {
    return this.state === OBJECTIVE_STATE.DONE;
  }

  get active() {
    return this.state === OBJECTIVE_STATE.ACTIVE;
  }

  /** Human-readable progress suffix for the HUD, or '' when not applicable. */
  get progressLabel() {
    if (this.type === OBJECTIVE_TYPE.SURVIVE_TIMER) {
      return `${Math.max(0, Math.ceil(this.duration - this.elapsed))}s`;
    }
    if (this.count > 1) return `${this.progress}/${this.count}`;
    return '';
  }

  get fraction() {
    if (this.type === OBJECTIVE_TYPE.SURVIVE_TIMER) {
      return clamp01(this.elapsed / Math.max(0.001, this.duration));
    }
    return clamp01(this.progress / this.count);
  }
}

/** Ordered objective list with exactly one active objective at a time. */
export class ObjectiveList {
  constructor(defs, bus) {
    this.bus = bus;
    this.items = defs.map((d) => new Objective(d));
    this.byId = new Map(this.items.map((o) => [o.id, o]));
    this.completedOrder = [];
  }

  reset() {
    for (const o of this.items) {
      o.state = OBJECTIVE_STATE.LOCKED;
      o.progress = 0;
      o.elapsed = 0;
    }
    this.completedOrder.length = 0;
    if (this.items.length) this.activate(this.items[0].id);
  }

  get(id) {
    return this.byId.get(id);
  }

  get active() {
    return this.items.find((o) => o.active) || null;
  }

  get allDone() {
    return this.items.every((o) => o.done);
  }

  get doneCount() {
    return this.items.filter((o) => o.done).length;
  }

  activate(id) {
    const o = this.byId.get(id);
    if (!o || o.done) return false;
    o.state = OBJECTIVE_STATE.ACTIVE;
    o.elapsed = 0;
    this.bus?.emit('objective:activated', { id: o.id, label: o.label, objective: o });
    return true;
  }

  /** Advance a counted objective; completes it when the count is reached. */
  advance(id, amount = 1) {
    const o = this.byId.get(id);
    if (!o || !o.active) return false;
    o.progress = Math.min(o.count, o.progress + amount);
    this.bus?.emit('objective:progress', { id: o.id, progress: o.progress, count: o.count });
    if (o.progress >= o.count) return this.complete(id);
    return false;
  }

  complete(id) {
    const o = this.byId.get(id);
    if (!o || o.done) return false;
    o.state = OBJECTIVE_STATE.DONE;
    o.progress = o.count;
    this.completedOrder.push(o.id);
    this.bus?.emit('objective:completed', { id: o.id, label: o.label, objective: o });
    const next = this.items.find((x) => x.state === OBJECTIVE_STATE.LOCKED);
    if (next) this.activate(next.id);
    return true;
  }

  /**
   * Per-step evaluation of the active objective against world state.
   * @param {object} ctx {playerPos, dt, aliveEnemies}
   */
  update(ctx) {
    const o = this.active;
    if (!o) return;
    switch (o.type) {
      case OBJECTIVE_TYPE.REACH:
        if (o.marker && planarDist(ctx.playerPos, o.marker) <= o.radius &&
            Math.abs(ctx.playerPos.y - o.marker.y) <= 4) {
          this.complete(o.id);
        }
        break;
      case OBJECTIVE_TYPE.SURVIVE_TIMER:
        o.elapsed += ctx.dt;
        if (o.elapsed >= o.duration) this.complete(o.id);
        break;
      case OBJECTIVE_TYPE.ELIMINATE:
        if (ctx.aliveEnemies === 0 && o.progress > 0) this.complete(o.id);
        break;
      default:
        break; // INTERACT / INTERACT_HOLD are driven by interaction events
    }
  }

  /** Snapshot for the HUD; stable object identity is not required. */
  snapshot() {
    return this.items.map((o) => ({
      id: o.id,
      label: o.label,
      state: o.state,
      progressLabel: o.progressLabel,
      marker: o.marker,
      fraction: o.fraction,
    }));
  }
}

/** The mission's objective definitions — GAME_SPEC §3. */
export const MISSION_OBJECTIVES = [
  {
    id: 'obj_approach',
    type: OBJECTIVE_TYPE.REACH,
    label: 'Infiltrate the substation',
    hint: 'Move up the dock and enter the pump hall.',
    marker: { x: 0, y: 0, z: 22 },
    radius: 5,
    phase: 'approach',
  },
  {
    id: 'obj_power',
    type: OBJECTIVE_TYPE.INTERACT,
    label: 'Cut power to the security grid',
    hint: 'Pull both breakers in the pump hall.',
    marker: { x: -19.4, y: 1.35, z: 12 },
    count: 2,
    phase: 'pump_hall',
  },
  {
    id: 'obj_core',
    type: OBJECTIVE_TYPE.INTERACT_HOLD,
    label: 'Retrieve the data core',
    hint: 'Hold E on the core in the server room.',
    marker: { x: -10, y: 1.25, z: -30 },
    phase: 'server_room',
  },
  {
    id: 'obj_exfil',
    type: OBJECTIVE_TYPE.REACH,
    label: 'Reach the helipad',
    hint: 'Fight out through the catwalks.',
    marker: { x: 35, y: 6.4, z: 1 },
    radius: 6,
    phase: 'withdrawal',
  },
  {
    id: 'obj_hold',
    type: OBJECTIVE_TYPE.SURVIVE_TIMER,
    label: 'Hold for extraction',
    hint: 'Survive until the bird arrives.',
    marker: { x: 37, y: 6.4, z: 1 },
    radius: 9,
    duration: 45,
    phase: 'extraction',
  },
];
