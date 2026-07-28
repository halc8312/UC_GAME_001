import { mean, percentile } from './mathx.js';

/**
 * Frame instrumentation. Keeps a bounded ring of samples so a long soak cannot grow
 * the heap, and separates CPU simulation cost from render-submit cost — under
 * software rendering only the simulation number is hardware-independent.
 */
export class Metrics {
  constructor(capacity = 3600) {
    this.capacity = capacity;
    this.frame = new Float32Array(capacity);
    this.sim = new Float32Array(capacity);
    this.render = new Float32Array(capacity);
    this.count = 0;
    this.head = 0;
    this.marks = [];
    this._simStart = 0;
    this._renderStart = 0;
    this.lastSim = 0;
    this.lastRender = 0;
    this.lastFrame = 0;
    this.drawCalls = 0;
    this.triangles = 0;
    this.programs = 0;
    this.geometries = 0;
    this.textures = 0;
    this._now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  beginSim() {
    this._simStart = this._now();
  }

  endSim() {
    this.lastSim = this._now() - this._simStart;
  }

  beginRender() {
    this._renderStart = this._now();
  }

  endRender() {
    this.lastRender = this._now() - this._renderStart;
  }

  /** Record one frame; `frameMs` is wall clock between rAF callbacks. */
  push(frameMs) {
    this.lastFrame = frameMs;
    const i = this.head;
    this.frame[i] = frameMs;
    this.sim[i] = this.lastSim;
    this.render[i] = this.lastRender;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Pull renderer counters (three's WebGLRenderer.info). */
  sampleRenderer(renderer) {
    if (!renderer || !renderer.info) return;
    const r = renderer.info.render;
    const m = renderer.info.memory;
    this.drawCalls = r.calls;
    this.triangles = r.triangles;
    this.programs = renderer.info.programs ? renderer.info.programs.length : 0;
    this.geometries = m.geometries;
    this.textures = m.textures;
  }

  /** Named point-in-time annotation, e.g. the start of a mission beat. */
  mark(name, extra) {
    this.marks.push({ name, at: this._now(), frame: this.count, ...extra });
  }

  _slice(buf) {
    if (this.count < this.capacity) return Array.from(buf.subarray(0, this.count));
    const out = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) out[i] = buf[(this.head + i) % this.capacity];
    return out;
  }

  heapMB() {
    const m = typeof performance !== 'undefined' ? performance.memory : null;
    return m ? m.usedJSHeapSize / 1048576 : null;
  }

  summary() {
    const frames = this._slice(this.frame);
    const sims = this._slice(this.sim);
    const renders = this._slice(this.render);
    const fps = frames.filter((f) => f > 0).map((f) => 1000 / f);
    return {
      samples: frames.length,
      frameMs: {
        mean: +mean(frames).toFixed(3),
        p50: +percentile(frames, 50).toFixed(3),
        p95: +percentile(frames, 95).toFixed(3),
        p99: +percentile(frames, 99).toFixed(3),
        max: +Math.max(0, ...frames).toFixed(3),
      },
      simMs: {
        mean: +mean(sims).toFixed(3),
        p95: +percentile(sims, 95).toFixed(3),
        p99: +percentile(sims, 99).toFixed(3),
        max: +Math.max(0, ...sims).toFixed(3),
      },
      renderMs: {
        mean: +mean(renders).toFixed(3),
        p95: +percentile(renders, 95).toFixed(3),
        max: +Math.max(0, ...renders).toFixed(3),
      },
      fps: {
        mean: +mean(fps).toFixed(2),
        p05: +percentile(fps, 5).toFixed(2),
      },
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: this.programs,
      geometries: this.geometries,
      textures: this.textures,
      heapMB: this.heapMB() === null ? null : +this.heapMB().toFixed(1),
      marks: this.marks,
    };
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.marks.length = 0;
  }
}
