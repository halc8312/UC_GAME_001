/** Tiny synchronous event bus. No allocation on emit for the common case. */
export class EventBus {
  constructor() {
    this._handlers = new Map();
    this._log = null;
  }

  /** Start recording every emitted event (used by e2e evidence capture). */
  startLog(limit = 4000) {
    this._log = { limit, entries: [] };
    return this;
  }

  getLog() {
    return this._log ? this._log.entries : [];
  }

  clearLog() {
    if (this._log) this._log.entries.length = 0;
  }

  on(type, fn) {
    let list = this._handlers.get(type);
    if (!list) this._handlers.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    if (this._log && this._log.entries.length < this._log.limit) {
      this._log.entries.push({ t: type, p: payload, at: Date.now() });
    }
    const list = this._handlers.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }

  clear() {
    this._handlers.clear();
  }
}

export const bus = new EventBus();
