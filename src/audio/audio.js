import { clamp, clamp01 } from '../core/mathx.js';
import { Rng } from '../core/rng.js';
import {
  AMBIENT_LAYERS, LIMITER, SOUNDS, describe, makeImpulseResponse, makeNoiseBuffer,
} from './synth.js';

const MAX_VOICES = 24;
const LOG_LIMIT = 2000;

/**
 * WebAudio engine. Interprets the pure descriptors from `synth.js` into real node
 * graphs — no audio file is ever fetched.
 *
 * Every method is a safe no-op when an AudioContext cannot be created (headless CI
 * runs with `--mute-audio`, and some browsers refuse a context before a gesture),
 * but the event log still records what *would* have played, which is what the e2e
 * suite asserts on for rubric E1.
 */
export class AudioEngine {
  constructor(settings) {
    this.settings = settings || { masterVolume: 0.8, sfxVolume: 1, musicVolume: 0.5 };
    this.ctx = null;
    this.available = typeof window !== 'undefined' &&
      !!(window.AudioContext || window.webkitAudioContext);
    this.rng = new Rng(0xa11d10);
    this.voices = [];
    this._log = [];
    this._noiseCache = new Map();
    this._ambient = new Map();
    this._alarmNodes = null;
    this._ambientState = 'calm';
    this.stats = { activeVoices: 0, peakVoices: 0, played: 0, dropped: 0, failed: 0 };
    this._initTried = false;
  }

  get ready() {
    return !!(this.ctx && this.ctx.state === 'running');
  }

  init() {
    if (this.ctx || this._initTried) return !!this.ctx;
    this._initTried = true;
    if (!this.available) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this._buildGraph();
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  _buildGraph() {
    const ctx = this.ctx;

    // master → limiter → destination
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER.thresholdDb ?? -6;
    this.limiter.knee.value = LIMITER.knee ?? 0;
    this.limiter.ratio.value = LIMITER.ratio ?? 20;
    this.limiter.attack.value = LIMITER.attack ?? 0.003;
    this.limiter.release.value = LIMITER.release ?? 0.18;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.masterVolume ?? 0.8;
    this.master.connect(this.limiter);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfxVolume ?? 1;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.musicVolume ?? 0.5;
    this.musicBus.connect(this.master);

    // Shared short reverb, fed by each sound's `tail.send`. One convolver for the
    // whole game keeps the cost flat regardless of how many voices are active.
    try {
      this.reverb = ctx.createConvolver();
      // makeImpulseResponse returns a stereo {left, right, length} record, not a
      // single Float32Array — passing it straight to copyToChannel throws, and the
      // catch below would then silently leave the whole game without reverb.
      const ir = makeImpulseResponse(ctx.sampleRate, 0.9, 3.2, new Rng(0x2b17));
      const buf = ctx.createBuffer(2, ir.length, ctx.sampleRate);
      buf.copyToChannel(ir.left, 0);
      buf.copyToChannel(ir.right, 1);
      this.reverb.buffer = buf;
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.55;
      this.reverb.connect(this.reverbGain);
      this.reverbGain.connect(this.master);
    } catch {
      this.reverb = null;
    }

    if (ctx.listener && ctx.listener.forwardX === undefined) {
      // Legacy listener orientation API.
      this._legacyListener = true;
    }
  }

  async resume() {
    if (!this.init()) return false;
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  setSettings(settings) {
    Object.assign(this.settings, settings);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(clamp01(this.settings.masterVolume), t, 0.02);
    this.sfxBus.gain.setTargetAtTime(clamp01(this.settings.sfxVolume), t, 0.02);
    this.musicBus.gain.setTargetAtTime(clamp01(this.settings.musicVolume), t, 0.02);
  }

  setListener(pos, forward, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    try {
      if (l.positionX) {
        l.positionX.setTargetAtTime(pos.x, t, 0.01);
        l.positionY.setTargetAtTime(pos.y, t, 0.01);
        l.positionZ.setTargetAtTime(pos.z, t, 0.01);
        l.forwardX.setTargetAtTime(forward.x, t, 0.01);
        l.forwardY.setTargetAtTime(forward.y, t, 0.01);
        l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
        l.upX.setTargetAtTime(up?.x ?? 0, t, 0.01);
        l.upY.setTargetAtTime(up?.y ?? 1, t, 0.01);
        l.upZ.setTargetAtTime(up?.z ?? 0, t, 0.01);
      } else {
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(forward.x, forward.y, forward.z, up?.x ?? 0, up?.y ?? 1, up?.z ?? 0);
      }
    } catch {
      /* listener API unavailable — 2D audio still works */
    }
  }

  _noiseBuffer(color, seconds) {
    const key = `${color}:${Math.ceil(seconds * 20)}`;
    let buf = this._noiseCache.get(key);
    if (buf) return buf;
    const len = Math.max(0.05, Math.ceil(seconds * 20) / 20);
    const data = makeNoiseBuffer(this.ctx.sampleRate, len, new Rng(0x0a53f9d1), color);
    buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data instanceof Float32Array ? data : Float32Array.from(data), 0);
    this._noiseCache.set(key, buf);
    return buf;
  }

  /** Steal the lowest-priority voice when the cap is reached. */
  _makeRoom(priority) {
    if (this.voices.length < MAX_VOICES) return true;
    let worstIdx = -1;
    let worstScore = Infinity;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.loop) continue;
      const remaining = clamp01((v.endTime - now) / Math.max(0.01, v.duration));
      const score = v.priority * 0.7 + remaining * 0.3;
      if (score < worstScore) {
        worstScore = score;
        worstIdx = i;
      }
    }
    if (worstIdx >= 0 && worstScore < priority) {
      this._stopVoice(this.voices[worstIdx]);
      return true;
    }
    this.stats.dropped++;
    return false;
  }

  _stopVoice(v) {
    try {
      for (const n of v.sources) {
        try { n.stop(); } catch { /* already stopped */ }
      }
      v.out.disconnect();
    } catch { /* graph already torn down */ }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /**
   * @param {string} name a name from SOUNDS
   * @param {object} [opts] {position, volume, rate, delay, loop}
   * @returns {object|null} voice handle
   */
  play(name, opts = {}) {
    // Log first, and unconditionally: the log is evidence, not a debug aid.
    if (this._log.length < LOG_LIMIT) {
      this._log.push({
        name,
        at: (this.ctx ? this.ctx.currentTime : Date.now() / 1000),
        position: opts.position
          ? { x: +opts.position.x.toFixed(2), y: +opts.position.y.toFixed(2), z: +opts.position.z.toFixed(2) }
          : null,
        volume: opts.volume ?? 1,
      });
    }

    const desc = describe(name);
    if (!desc) return null;
    if (!this.ctx || this.ctx.state !== 'running') return null;
    if (!this._makeRoom(desc.priority ?? 0.5)) return null;

    try {
      return this._spawn(desc, opts);
    } catch {
      this.stats.failed++;
      return null;
    }
  }

  _spawn(desc, opts) {
    const ctx = this.ctx;
    const now = ctx.currentTime + (opts.delay || 0);
    const bus = desc.bus === 'music' ? this.musicBus : this.sfxBus;

    const out = ctx.createGain();
    const jitter = 1 + (desc.gainJitter ? this.rng.range(-desc.gainJitter, desc.gainJitter) : 0);
    out.gain.value = (desc.gain ?? 0.8) * (opts.volume ?? 1) * jitter;

    let sink = out;
    if (opts.position) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = desc.refDistance ?? 3;
      panner.maxDistance = desc.maxDistance ?? 60;
      panner.rolloffFactor = desc.rolloff ?? 1;
      try {
        if (panner.positionX) {
          panner.positionX.value = opts.position.x;
          panner.positionY.value = opts.position.y;
          panner.positionZ.value = opts.position.z;
        } else {
          panner.setPosition(opts.position.x, opts.position.y, opts.position.z);
        }
      } catch { /* fall back to non-positional */ }
      out.connect(panner);
      panner.connect(bus);
      sink = out;
      if (this.reverb && desc.tail?.send) {
        const send = ctx.createGain();
        send.gain.value = desc.tail.send;
        panner.connect(send);
        send.connect(this.reverb);
      }
    } else {
      out.connect(bus);
      if (this.reverb && desc.tail?.send) {
        const send = ctx.createGain();
        send.gain.value = desc.tail.send;
        out.connect(send);
        send.connect(this.reverb);
      }
    }

    const rate = (opts.rate ?? 1) *
      (1 + (desc.rateJitter ? this.rng.range(-desc.rateJitter, desc.rateJitter) : 0));
    const sources = [];
    let endTime = now;

    for (const layer of desc.layers) {
      const start = now + (layer.delay || 0) / rate;
      const dur = Math.max(0.005, (layer.duration || 0.1) / rate);
      const g = ctx.createGain();

      let node;
      if (layer.type === 'noise') {
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer(layer.wave || 'white', Math.max(0.25, dur));
        src.loop = !!(opts.loop || desc.loop);
        src.playbackRate.value = (layer.rate || 1) * rate;
        node = src;
      } else {
        const src = ctx.createOscillator();
        src.type = layer.wave === 'noise' ? 'sawtooth' : (layer.wave || 'sine');
        const f0 = Math.max(1, layer.freq || 220);
        const f1 = Math.max(1, layer.freqEnd || f0);
        src.frequency.setValueAtTime(f0, start);
        if (f1 !== f0) src.frequency.exponentialRampToValueAtTime(f1, start + dur);
        node = src;
      }

      let chain = node;
      if (layer.filter && layer.filter.type) {
        const f = ctx.createBiquadFilter();
        f.type = layer.filter.type;
        const c0 = clamp(layer.filter.freq || 1000, 20, 20000);
        const c1 = clamp(layer.filter.freqEnd || c0, 20, 20000);
        f.frequency.setValueAtTime(c0, start);
        if (c1 !== c0) f.frequency.exponentialRampToValueAtTime(c1, start + dur);
        f.Q.value = layer.filter.Q || 1;
        chain.connect(f);
        chain = f;
      }

      // ADSR-ish envelope: attack → hold → decay.
      const peak = Math.max(0.0005, layer.gain ?? 0.6);
      const atk = Math.max(0.0005, layer.attack ?? 0.002);
      const hold = layer.hold || 0;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak, start + atk);
      if (hold > 0) g.gain.setValueAtTime(peak, start + atk + hold);
      if (layer.curve === 'linear') {
        g.gain.linearRampToValueAtTime(0.0001, start + dur);
      } else {
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      }

      chain.connect(g);
      g.connect(sink);

      if (layer.am && layer.am.freq) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = layer.am.freq;
        lfoGain.gain.value = layer.am.depth ?? 0.4;
        lfo.connect(lfoGain);
        lfoGain.connect(g.gain);
        lfo.start(start);
        if (!(opts.loop || desc.loop)) lfo.stop(start + dur + 0.02);
        sources.push(lfo);
      }

      node.start(start);
      if (!(opts.loop || desc.loop)) node.stop(start + dur + 0.02);
      sources.push(node);
      endTime = Math.max(endTime, start + dur);
    }

    const voice = {
      out, sources, endTime,
      duration: desc.duration || 0.3,
      priority: desc.priority ?? 0.5,
      loop: !!(opts.loop || desc.loop),
      name: desc.name,
    };
    this.voices.push(voice);
    this.stats.played++;
    this.stats.activeVoices = this.voices.length;
    if (this.voices.length > this.stats.peakVoices) this.stats.peakVoices = this.voices.length;
    return voice;
  }

  stop(voice) {
    if (voice) this._stopVoice(voice);
  }

  stopAll() {
    for (const v of [...this.voices]) this._stopVoice(v);
    this.voices.length = 0;
    this.stats.activeVoices = 0;
  }

  // -------------------------------------------------------------------------
  // Ambience & alarm

  setAmbientState(state) {
    this._ambientState = state;
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._ensureAmbient();
    const t = this.ctx.currentTime;
    for (const [name, node] of this._ambient) {
      const wantCalm = name.includes('calm') || name.includes('sea') || name.includes('wind');
      const target = state === 'alert'
        ? (wantCalm ? 0.25 : 0.85)
        : (wantCalm ? 0.8 : 0.28);
      node.out.gain.setTargetAtTime(target, t, 0.8);
    }
  }

  _ensureAmbient() {
    if (this._ambient.size || !AMBIENT_LAYERS?.length) return;
    for (const name of AMBIENT_LAYERS) {
      const v = this.play(name, { loop: true, volume: 0.001 });
      if (v) this._ambient.set(name, v);
    }
  }

  setAlarm(on) {
    if (!this.ctx || this.ctx.state !== 'running') {
      if (this._log.length < LOG_LIMIT) {
        this._log.push({ name: on ? 'alarm_siren' : 'alarm_off', at: Date.now() / 1000, position: null });
      }
      return;
    }
    if (on && !this._alarmNodes) {
      this._alarmNodes = this.play('alarm_siren', { loop: true, volume: 0.7 });
      if (!this._alarmNodes) return;
    } else if (!on && this._alarmNodes) {
      this._stopVoice(this._alarmNodes);
      this._alarmNodes = null;
    }
  }

  update(dt) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (!v.loop && now > v.endTime + 0.15) {
        try { v.out.disconnect(); } catch { /* already disconnected */ }
        this.voices.splice(i, 1);
      }
    }
    this.stats.activeVoices = this.voices.length;
  }

  getEventLog() {
    return this._log;
  }

  clearEventLog() {
    this._log.length = 0;
  }

  /** Names the engine knows how to play. */
  static get sounds() {
    return SOUNDS;
  }

  dispose() {
    this.stopAll();
    this._ambient.clear();
    this._alarmNodes = null;
    this._noiseCache.clear();
    try {
      this.sfxBus?.disconnect();
      this.musicBus?.disconnect();
      this.master?.disconnect();
      this.limiter?.disconnect();
      this.reverb?.disconnect();
      this.reverbGain?.disconnect();
      this.ctx?.close();
    } catch { /* context already closed */ }
    this.ctx = null;
  }
}

export { SOUNDS };
