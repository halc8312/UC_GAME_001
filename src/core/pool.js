/**
 * Fixed-capacity object pool. Hot-path systems (impacts, particles, tracers, audio
 * voices) allocate exclusively from here so steady-state play produces no garbage.
 */
export class Pool {
  /**
   * @param {number} capacity
   * @param {() => any} factory called `capacity` times up front
   * @param {(obj:any) => void} [reset] called when an object is returned
   */
  constructor(capacity, factory, reset) {
    this.capacity = capacity;
    this._reset = reset;
    this._items = new Array(capacity);
    this._free = new Array(capacity);
    this.active = [];
    for (let i = 0; i < capacity; i++) {
      this._items[i] = factory(i);
      this._free[i] = this._items[i];
    }
    this.peak = 0;
    this.starved = 0;
  }

  /** @returns {any|null} null when exhausted (callers must handle it) */
  acquire() {
    const obj = this._free.pop();
    if (!obj) {
      this.starved++;
      return null;
    }
    this.active.push(obj);
    if (this.active.length > this.peak) this.peak = this.active.length;
    return obj;
  }

  release(obj) {
    const i = this.active.indexOf(obj);
    if (i < 0) return false;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    if (this._reset) this._reset(obj);
    this._free.push(obj);
    return true;
  }

  /** Release by index into `active` — safe inside a reverse-iterating update loop. */
  releaseAt(i) {
    const obj = this.active[i];
    if (obj === undefined) return false;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    if (this._reset) this._reset(obj);
    this._free.push(obj);
    return true;
  }

  releaseAll() {
    for (let i = this.active.length - 1; i >= 0; i--) this.releaseAt(i);
  }

  get all() {
    return this._items;
  }

  get freeCount() {
    return this._free.length;
  }
}
