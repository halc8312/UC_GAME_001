import { clamp } from './mathx.js';

export const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;

/**
 * Fixed-timestep simulation loop with a decoupled render callback.
 *
 * Gameplay only ever advances in `FIXED_DT` increments so behaviour is identical at
 * 30 fps and 240 fps, and so headless tests can drive the exact same code path by
 * calling `stepManual()`.
 */
export class Loop {
  /**
   * @param {(dt:number, tick:number) => void} onFixed
   * @param {(alpha:number, frameDt:number) => void} onRender
   */
  constructor(onFixed, onRender) {
    this.onFixed = onFixed;
    this.onRender = onRender;
    this.accumulator = 0;
    this.tick = 0;
    this.simTime = 0;
    this.running = false;
    this.paused = false;
    this.timeScale = 1;
    this.lastTime = 0;
    this.frameDt = 0;
    this.stepsLastFrame = 0;
    this.droppedSteps = 0;
    this._raf = 0;
    this._frame = this._frame.bind(this);
    this._now = () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = this._now();
    this.accumulator = 0;
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  setPaused(v) {
    if (this.paused === v) return;
    this.paused = v;
    // Drop accumulated time so unpausing does not fast-forward the simulation.
    if (!v) {
      this.lastTime = this._now();
      this.accumulator = 0;
    }
  }

  _frame() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const now = this._now();
    // Clamp so an alt-tab or a breakpoint cannot inject a huge dt.
    const frameDt = clamp((now - this.lastTime) / 1000, 0, 0.25);
    this.lastTime = now;
    this.frameDt = frameDt;
    this.advance(frameDt);
  }

  /** Advance by wall-clock seconds; runs 0..MAX_STEPS fixed steps then renders. */
  advance(frameDt) {
    let steps = 0;
    if (!this.paused) {
      this.accumulator += frameDt * this.timeScale;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        this.onFixed(FIXED_DT, this.tick++);
        this.simTime += FIXED_DT;
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (this.accumulator >= FIXED_DT) {
        // Too far behind to catch up: drop the backlog rather than spiral.
        this.droppedSteps += Math.floor(this.accumulator / FIXED_DT);
        this.accumulator = 0;
      }
    }
    this.stepsLastFrame = steps;
    const alpha = this.paused ? 1 : this.accumulator / FIXED_DT;
    this.onRender(alpha, frameDt);
  }

  /** Deterministic manual stepping for tests: run exactly `n` fixed steps. */
  stepManual(n = 1, render = false) {
    for (let i = 0; i < n; i++) {
      this.onFixed(FIXED_DT, this.tick++);
      this.simTime += FIXED_DT;
    }
    if (render) this.onRender(0, FIXED_DT * n);
  }
}
