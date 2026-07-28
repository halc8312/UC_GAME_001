/**
 * src/audio/synth.js — sound design data and DSP helpers for *Operation Undercurrent*.
 *
 * This module is deliberately **pure and DOM-free**: it never touches `AudioContext`,
 * `window`, or any browser global, so the whole sound bank can be unit-tested in Node
 * (see `tests/unit/audio.test.js`). It exports two kinds of thing:
 *
 *   1. **Descriptors** — plain, deep-frozen data describing how a sound is built out of
 *      oscillator and noise layers. `describe(name)` hands one back. The engine in
 *      `audio.js` is the only thing that turns a descriptor into real WebAudio nodes.
 *   2. **Pure DSP / mixer maths** — `makeNoiseBuffer`, `applyEnvelope`, `envelopeAt`,
 *      `attenuationAt`, `limiterGainFor`, `estimatePeak`, `pickVoiceToSteal`. These are
 *      used by the engine at runtime *and* asserted directly by the unit suite, so the
 *      rubric's audio criteria (E2 distance attenuation, E3 limiter) are proven against
 *      the same code the game runs.
 *
 * Nothing here is ever fetched. Every waveform is generated from first principles.
 * `Math.random()` is banned project-wide (AGENTS.md §5) — all randomness routes through
 * the seeded PRNG in `../core/rng.js`.
 *
 * ## Descriptor shape
 * ```
 * {
 *   name, category, bus: 'sfx'|'music', loop,
 *   gain,            // 0..1 overall trim
 *   pan,             // -1..1 static stereo placement for non-positional plays
 *   priority,        // 0..1 hint used when the voice cap forces a casualty
 *   duration,        // seconds, derived: max(delay + layer duration) + tail.time
 *   peak,            // derived worst-case summed amplitude, drives the limiter rider
 *   tail: { send, time } | null,          // procedural convolution reverb send
 *   refDistance, maxDistance, rolloff,    // PannerNode inverse-distance parameters
 *   rateJitter, gainJitter,               // per-play variation, applied with a private Rng
 *   layers: [{
 *     type: 'noise'|'osc',
 *     wave,            // osc: 'sine'|'square'|'sawtooth'|'triangle'; noise: colour
 *     freq, freqEnd,   // osc only (Hz, swept); 0 for noise layers
 *     rate,            // noise only: buffer playback rate
 *     delay,           // start offset from the top of the sound
 *     attack, hold, decay,
 *     duration,        // derived: attack + hold + decay (invariant, never exceeded)
 *     gain,            // 0..1
 *     curve,           // 'exp' | 'linear' decay shape
 *     filter: { type, freq, freqEnd, Q } | null,
 *     am: { rate, depth } | null,         // amplitude modulation (rotor chop, tremolo)
 *   }]
 * }
 * ```
 */

import { Rng } from '../core/rng.js';
import { clamp, clamp01 } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
export const NOISE_COLORS = ['white', 'pink', 'brown'];
export const FILTER_TYPES = [
  'lowpass', 'highpass', 'bandpass', 'notch',
  'peaking', 'lowshelf', 'highshelf', 'allpass',
];
export const BUSES = ['sfx', 'music'];

/** Shortest meaningful envelope segment, in seconds. */
export const MIN_TIME = 0.001;
/** Lowest frequency we will ever ask an oscillator or filter for. */
export const MIN_FREQ = 1;
/** Steepness of the exponential decay curve used by `envelopeAt`. */
export const DECAY_K = 5;
/** Default seed for `makeNoiseBuffer` so it is deterministic even with no Rng passed. */
export const NOISE_SEED = 0x0a53f9d1;

/**
 * Master limiter settings. `thresholdDb` is shared by the `DynamicsCompressorNode`
 * that sits between the master bus and the destination *and* by `limiterGainFor`,
 * the pure gain rider the engine applies to the SFX bus.
 */
export const LIMITER = Object.freeze({
  thresholdDb: -3,
  knee: 0,
  ratio: 20,
  attack: 0.002,
  release: 0.18,
});

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-6, g));

/** Linear-amplitude form of `LIMITER.thresholdDb` (~0.708). */
export const LIMITER_THRESHOLD = dbToGain(LIMITER.thresholdDb);

/** Below this effective amplitude a sound is inaudible and never gets a voice. */
export const INAUDIBLE = 0.0008;

// ---------------------------------------------------------------------------
// Envelope maths
// ---------------------------------------------------------------------------

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Attack / hold / decay envelope value at time `t`, in [0, 1].
 *
 * Exactly 0 before t=0 and at/after t = attack + hold + decay, so a layer can never
 * ring past its own declared duration. The decay is an exponential curve normalised to
 * land precisely on zero (`curve: 'linear'` selects a straight line instead).
 *
 * @param {number} t seconds from the start of the layer
 * @param {{attack?:number, hold?:number, decay?:number, curve?:string}} env
 * @returns {number} gain multiplier in [0, 1]
 */
export function envelopeAt(t, env = {}) {
  if (!Number.isFinite(t) || t < 0) return 0;
  const attack = Math.max(0, num(env.attack, 0));
  const hold = Math.max(0, num(env.hold, 0));
  const decay = Math.max(0, num(env.decay, 0));
  const total = attack + hold + decay;
  if (total <= 0) return 0;
  if (t >= total) return 0;
  if (t < attack) return clamp01(t / attack);
  if (t < attack + hold) return 1;
  if (decay <= 0) return 0;
  const u = clamp01((t - attack - hold) / decay);
  if (env.curve === 'linear') return clamp01(1 - u);
  const e = Math.exp(-DECAY_K);
  return clamp01((Math.exp(-DECAY_K * u) - e) / (1 - e));
}

/**
 * Multiply `samples` in place by the envelope described by `env`. Returns the same
 * array so calls can be chained. Used to shape generated buffers (impulse responses,
 * one-shot noise beds) before they are handed to the WebAudio graph.
 *
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @param {{attack?:number, hold?:number, decay?:number, curve?:string}} env
 * @param {number} [startIndex] first sample the envelope applies from
 */
export function applyEnvelope(samples, sampleRate, env = {}, startIndex = 0) {
  if (!samples || typeof samples.length !== 'number') return samples;
  const sr = Math.max(1, num(sampleRate, 1));
  const from = Math.max(0, Math.floor(num(startIndex, 0)));
  for (let i = 0; i < samples.length; i++) {
    if (i < from) {
      samples[i] = 0;
      continue;
    }
    samples[i] *= envelopeAt((i - from) / sr, env);
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Noise generation
// ---------------------------------------------------------------------------

/** Peak that pink/brown noise is normalised to, leaving a little headroom. */
const NOISE_PEAK = 0.95;

/**
 * Generate a deterministic noise buffer.
 *
 * White noise comes straight out of the PRNG in [-1, 1). Pink noise uses Paul Kellet's
 * economy filter; brown noise is a leaky integrator. Both coloured variants are peak
 * normalised to {@link NOISE_PEAK}, so every result is bounded by ±1 regardless of
 * colour or length.
 *
 * Deterministic: the same `rng` seed and arguments always yield identical samples.
 *
 * @param {number} sampleRate
 * @param {number} seconds
 * @param {Rng} [rngIn] seeded PRNG; a fixed-seed one is used when omitted
 * @param {'white'|'pink'|'brown'} [color]
 * @returns {Float32Array} length = max(1, floor(sampleRate * seconds))
 */
export function makeNoiseBuffer(sampleRate, seconds, rngIn, color = 'white') {
  const sr = Math.max(1, Math.floor(num(sampleRate, 1)));
  const secs = Math.max(0, num(seconds, 0));
  const n = Math.max(1, Math.floor(sr * secs));
  const r = rngIn instanceof Rng ? rngIn : new Rng(NOISE_SEED);
  const out = new Float32Array(n);

  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    normalizePeak(out, NOISE_PEAK);
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = r.next() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      out[i] = last;
    }
    normalizePeak(out, NOISE_PEAK);
  } else {
    for (let i = 0; i < n; i++) out[i] = r.next() * 2 - 1;
  }
  return out;
}

/** Scale `data` in place so its largest absolute sample equals `peak`. No-op if silent. */
export function normalizePeak(data, peak = 1) {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > max) max = a;
  }
  if (max <= 1e-9) return data;
  const s = peak / max;
  for (let i = 0; i < data.length; i++) data[i] *= s;
  return data;
}

/**
 * Build a stereo impulse response for the procedural convolution tail: decaying noise
 * with a slight inter-channel decorrelation so the reverb has width. Pure — the engine
 * copies the result into a real `AudioBuffer`.
 *
 * @returns {{left: Float32Array, right: Float32Array, length: number}}
 */
export function makeImpulseResponse(sampleRate, seconds = 0.9, decay = 3.2, rngIn) {
  const sr = Math.max(1, Math.floor(num(sampleRate, 1)));
  const secs = Math.max(MIN_TIME, num(seconds, 0.9));
  const k = Math.max(0.1, num(decay, 3.2));
  const n = Math.max(1, Math.floor(sr * secs));
  const r = rngIn instanceof Rng ? rngIn : new Rng(NOISE_SEED ^ 0x51ab);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = Math.pow(1 - u, k);
    left[i] = (r.next() * 2 - 1) * env;
    right[i] = (r.next() * 2 - 1) * env;
  }
  return { left, right, length: n };
}

// ---------------------------------------------------------------------------
// Mixer maths — rubric E2 (attenuation) and E3 (limiter)
// ---------------------------------------------------------------------------

/**
 * Inverse-distance attenuation, matching the `PannerNode` `distanceModel: 'inverse'`
 * the engine configures, with `distance` additionally clamped to `maxDistance` (the
 * engine treats anything past `maxDistance` as being at `maxDistance`).
 *
 * Guarantees, all asserted in the unit suite (rubric E2):
 *  - returns exactly 1 at and inside `refDistance`;
 *  - is monotonically non-increasing in `distance`, strictly decreasing between
 *    `refDistance` and `maxDistance` whenever `rolloff > 0`;
 *  - is always within (0, 1] — never negative, never amplifying.
 *
 * @param {number} distance metres from the listener
 * @param {number} [refDistance] distance at which the sound plays at full volume
 * @param {number} [maxDistance] distance past which attenuation stops changing
 * @param {number} [rolloff] how quickly volume falls off; 0 disables attenuation
 */
export function attenuationAt(distance, refDistance = 1, maxDistance = 10000, rolloff = 1) {
  const ref = Math.max(1e-4, num(refDistance, 1));
  const max = Math.max(ref, num(maxDistance, ref));
  const roll = Math.max(0, num(rolloff, 1));
  let d = Math.abs(num(distance, 0));
  if (d < ref) d = ref;
  if (d > max) d = max;
  return clamp01(ref / (ref + roll * (d - ref)));
}

/**
 * Gain that must be applied to a bus whose voices sum to `peakSum` so the result cannot
 * exceed `threshold`. This is a hard (zero-knee) limiter: the returned gain `g` always
 * satisfies `peakSum * g <= threshold`, which is exactly what rubric E3 asks to be
 * proven. The engine smooths `g` over time (fast attack, slow release) and multiplies
 * it into the SFX bus, ahead of the `DynamicsCompressorNode` catch-all.
 *
 * @param {number} peakSum summed worst-case amplitude of the currently sounding voices
 * @param {number} [threshold] linear amplitude ceiling, default {@link LIMITER_THRESHOLD}
 * @returns {number} gain in [0, 1]
 */
export function limiterGainFor(peakSum, threshold = LIMITER_THRESHOLD) {
  const t = Math.max(0, num(threshold, 0));
  const p = Math.abs(num(peakSum, 0));
  if (p <= t || p <= 0) return 1;
  return clamp01(t / p);
}

/**
 * Worst-case summed amplitude of a descriptor, found by evaluating every layer's
 * envelope at every other layer's peak instant. Cached onto the descriptor as `.peak`
 * so the engine never recomputes it in the hot path.
 */
export function estimatePeak(desc) {
  if (!desc || !Array.isArray(desc.layers) || !desc.layers.length) return 0;
  let peak = 0;
  for (let i = 0; i < desc.layers.length; i++) {
    const t = desc.layers[i].delay + desc.layers[i].attack;
    let sum = 0;
    for (let j = 0; j < desc.layers.length; j++) {
      const m = desc.layers[j];
      sum += m.gain * envelopeAt(t - m.delay, m);
    }
    if (sum > peak) peak = sum;
  }
  return peak * (desc.gain ?? 1);
}

/**
 * Score a sounding voice for the voice-stealing contest. Quiet voices and voices that
 * are nearly finished score low and are sacrificed first — "quietest / oldest".
 *
 * @param {number} effectiveGain post-attenuation amplitude
 * @param {number} remaining01 fraction of the sound still to play, 1 = just started
 * @param {number} [priority] descriptor priority hint, 0..1
 */
export function voiceScore(effectiveGain, remaining01, priority = 0.5) {
  const g = Math.max(0, num(effectiveGain, 0));
  const r = clamp01(num(remaining01, 0));
  const p = clamp01(num(priority, 0.5));
  return g * (0.35 + 0.65 * r) * (0.6 + 0.8 * p);
}

/**
 * Choose which sounding voice to sacrifice for an incoming sound.
 *
 * @param {number[]} scores scores of the currently sounding voices
 * @param {number} candidateScore score the incoming sound would have
 * @returns {number} index to steal, or -1 to drop the incoming sound instead
 */
export function pickVoiceToSteal(scores, candidateScore) {
  if (!Array.isArray(scores) || scores.length === 0) return -1;
  let best = -1;
  let min = Infinity;
  for (let i = 0; i < scores.length; i++) {
    const s = num(scores[i], 0);
    if (s < min) {
      min = s;
      best = i;
    }
  }
  return min < num(candidateScore, 0) ? best : -1;
}

// ---------------------------------------------------------------------------
// Descriptor construction
// ---------------------------------------------------------------------------

function normFilter(f) {
  if (!f) return null;
  const type = FILTER_TYPES.includes(f.type) ? f.type : 'lowpass';
  const freq = Math.max(MIN_FREQ, num(f.freq, 1000));
  return Object.freeze({
    type,
    freq,
    freqEnd: Math.max(MIN_FREQ, num(f.freqEnd, freq)),
    Q: clamp(num(f.Q, 1), 0.0001, 40),
  });
}

function normAm(am) {
  if (!am) return null;
  return Object.freeze({
    rate: Math.max(0.01, num(am.rate, 8)),
    depth: clamp01(num(am.depth, 0.5)),
  });
}

/**
 * Normalise one layer. `duration` is *derived* from attack + hold + decay rather than
 * declared, which makes the "envelope times never exceed duration" invariant structural
 * instead of a thing the sound designer has to remember.
 */
function normLayer(l) {
  const isOsc = l.type === 'osc';
  const attack = Math.max(0, num(l.attack, 0.002));
  const hold = Math.max(0, num(l.hold, 0));
  const decay = Math.max(MIN_TIME, num(l.decay, 0.08));
  const freq = isOsc ? Math.max(MIN_FREQ, num(l.freq, 440)) : 0;
  return Object.freeze({
    type: isOsc ? 'osc' : 'noise',
    wave: isOsc
      ? (WAVES.includes(l.wave) ? l.wave : 'sine')
      : (NOISE_COLORS.includes(l.wave) ? l.wave : 'white'),
    freq,
    freqEnd: isOsc ? Math.max(MIN_FREQ, num(l.freqEnd, freq)) : 0,
    rate: isOsc ? 1 : clamp(num(l.rate, 1), 0.25, 4),
    delay: Math.max(0, num(l.delay, 0)),
    attack,
    hold,
    decay,
    duration: attack + hold + decay,
    gain: clamp(num(l.gain, 0.4), 0, 1),
    curve: l.curve === 'linear' ? 'linear' : 'exp',
    filter: normFilter(l.filter),
    am: normAm(l.am),
  });
}

/** Noise-layer shorthand. */
const nz = (o = {}) => normLayer({ ...o, type: 'noise' });
/** Oscillator-layer shorthand. */
const os = (o = {}) => normLayer({ ...o, type: 'osc' });

const CATEGORY_BUS = {
  music: 'music',
  ambient: 'music',
  alarm: 'music',
};

function makeDescriptor(name, o) {
  const layers = (o.layers || []).map((l) => (Object.isFrozen(l) ? l : normLayer(l)));
  const tail = o.tail
    ? Object.freeze({
        send: clamp01(num(o.tail.send, 0.2)),
        time: Math.max(0, num(o.tail.time, 0.3)),
      })
    : null;
  let span = 0;
  for (const l of layers) span = Math.max(span, l.delay + l.duration);
  const category = o.category || 'sfx';
  const desc = {
    name,
    category,
    bus: CATEGORY_BUS[category] || 'sfx',
    loop: !!o.loop,
    gain: clamp(num(o.gain, 0.7), 0.0001, 1),
    pan: clamp(num(o.pan, 0), -1, 1),
    priority: clamp01(num(o.priority, 0.5)),
    duration: Math.max(MIN_TIME, span + (tail ? tail.time : 0)),
    tail,
    refDistance: Math.max(0.1, num(o.refDistance, 3)),
    maxDistance: Math.max(1, num(o.maxDistance, 60)),
    rolloff: Math.max(0, num(o.rolloff, 1.1)),
    rateJitter: clamp(num(o.rateJitter, 0.03), 0, 0.5),
    gainJitter: clamp(num(o.gainJitter, 0.05), 0, 0.5),
    layers: Object.freeze(layers),
    peak: 0,
  };
  desc.peak = estimatePeak(desc);
  return Object.freeze(desc);
}

// ---------------------------------------------------------------------------
// The sound bank
// ---------------------------------------------------------------------------

/**
 * Every sound the engine can play, keyed by name. Each entry is a distinct piece of
 * sound design — no two descriptors share a layer stack.
 */
const BANK = {
  // --- Player weapons ------------------------------------------------------
  rifle_fire: {
    category: 'weapon', gain: 0.85, priority: 0.95, refDistance: 4, maxDistance: 90,
    rolloff: 0.9, rateJitter: 0.05, tail: { send: 0.22, time: 0.28 },
    layers: [
      nz({ attack: 0.0005, hold: 0.004, decay: 0.09, gain: 0.9,
           filter: { type: 'highpass', freq: 900, freqEnd: 400, Q: 0.9 } }),
      nz({ attack: 0.0003, decay: 0.035, gain: 0.7,
           filter: { type: 'bandpass', freq: 2600, freqEnd: 1200, Q: 1.4 } }),
      os({ wave: 'square', freq: 180, freqEnd: 60, attack: 0.001, decay: 0.11, gain: 0.45,
           filter: { type: 'lowpass', freq: 700, Q: 0.8 } }),
      nz({ wave: 'brown', delay: 0.03, attack: 0.01, decay: 0.32, gain: 0.22,
           filter: { type: 'lowpass', freq: 1400, freqEnd: 300, Q: 0.7 } }),
    ],
  },
  shotgun_fire: {
    category: 'weapon', gain: 0.95, priority: 1, refDistance: 4, maxDistance: 100,
    rolloff: 0.85, rateJitter: 0.04, tail: { send: 0.3, time: 0.45 },
    layers: [
      nz({ attack: 0.0006, hold: 0.008, decay: 0.18, gain: 1,
           filter: { type: 'lowpass', freq: 3800, freqEnd: 600, Q: 0.7 } }),
      os({ wave: 'sawtooth', freq: 120, freqEnd: 38, attack: 0.001, decay: 0.22, gain: 0.6,
           filter: { type: 'lowpass', freq: 420, Q: 0.9 } }),
      nz({ wave: 'brown', delay: 0.02, attack: 0.015, decay: 0.5, gain: 0.3,
           filter: { type: 'lowpass', freq: 900, freqEnd: 180, Q: 0.7 } }),
    ],
  },
  rifle_reload_start: {
    category: 'mech', gain: 0.55, priority: 0.5, refDistance: 2, maxDistance: 26,
    layers: [
      os({ wave: 'square', freq: 1400, freqEnd: 900, attack: 0.0005, decay: 0.02, gain: 0.3,
           filter: { type: 'bandpass', freq: 1800, Q: 3 } }),
      nz({ delay: 0.012, attack: 0.001, decay: 0.05, gain: 0.35,
           filter: { type: 'highpass', freq: 2200, Q: 0.8 } }),
      os({ wave: 'triangle', freq: 240, freqEnd: 120, delay: 0.05, attack: 0.002,
           decay: 0.09, gain: 0.28, filter: { type: 'lowpass', freq: 900, Q: 0.9 } }),
    ],
  },
  rifle_reload_end: {
    category: 'mech', gain: 0.6, priority: 0.5, refDistance: 2, maxDistance: 26,
    layers: [
      nz({ attack: 0.001, decay: 0.045, gain: 0.4,
           filter: { type: 'bandpass', freq: 1600, Q: 2 } }),
      os({ wave: 'square', freq: 320, freqEnd: 160, delay: 0.02, attack: 0.001,
           decay: 0.07, gain: 0.4, filter: { type: 'lowpass', freq: 1200, Q: 0.9 } }),
      nz({ delay: 0.14, attack: 0.0008, decay: 0.03, gain: 0.45,
           filter: { type: 'highpass', freq: 3000, Q: 0.8 } }),
      os({ wave: 'square', freq: 900, freqEnd: 520, delay: 0.145, attack: 0.0005,
           decay: 0.04, gain: 0.3, filter: { type: 'bandpass', freq: 1400, Q: 4 } }),
    ],
  },
  shotgun_shell: {
    category: 'mech', gain: 0.5, pan: 0.25, priority: 0.4, refDistance: 2, maxDistance: 20,
    rateJitter: 0.08,
    layers: [
      nz({ attack: 0.0008, decay: 0.035, gain: 0.4,
           filter: { type: 'bandpass', freq: 2400, Q: 2.5 } }),
      os({ wave: 'triangle', freq: 520, freqEnd: 300, delay: 0.015, attack: 0.001,
           decay: 0.05, gain: 0.25 }),
    ],
  },
  shotgun_pump: {
    category: 'mech', gain: 0.6, priority: 0.55, refDistance: 2, maxDistance: 26,
    layers: [
      nz({ attack: 0.001, decay: 0.06, gain: 0.5,
           filter: { type: 'bandpass', freq: 1100, freqEnd: 700, Q: 1.6 } }),
      os({ wave: 'square', freq: 260, freqEnd: 140, attack: 0.001, decay: 0.08, gain: 0.35,
           filter: { type: 'lowpass', freq: 900, Q: 0.9 } }),
      nz({ delay: 0.13, attack: 0.001, decay: 0.07, gain: 0.5,
           filter: { type: 'bandpass', freq: 900, freqEnd: 600, Q: 1.6 } }),
      os({ wave: 'square', freq: 220, freqEnd: 120, delay: 0.13, attack: 0.001,
           decay: 0.09, gain: 0.35, filter: { type: 'lowpass', freq: 800, Q: 0.9 } }),
    ],
  },
  dry_fire: {
    category: 'mech', gain: 0.45, priority: 0.6, refDistance: 2, maxDistance: 16,
    layers: [
      os({ wave: 'square', freq: 1900, freqEnd: 1200, attack: 0.0003, decay: 0.018,
           gain: 0.3, filter: { type: 'bandpass', freq: 2200, Q: 5 } }),
      nz({ attack: 0.0003, decay: 0.012, gain: 0.25,
           filter: { type: 'highpass', freq: 3500, Q: 0.8 } }),
    ],
  },
  weapon_switch: {
    category: 'mech', gain: 0.45, pan: 0.1, priority: 0.45, refDistance: 2, maxDistance: 16,
    layers: [
      nz({ wave: 'pink', attack: 0.01, decay: 0.12, gain: 0.3,
           filter: { type: 'bandpass', freq: 900, freqEnd: 2200, Q: 0.8 } }),
      os({ wave: 'triangle', freq: 600, freqEnd: 340, delay: 0.09, attack: 0.001,
           decay: 0.06, gain: 0.25 }),
    ],
  },

  // --- Surface impacts -----------------------------------------------------
  impact_concrete: {
    category: 'impact', gain: 0.6, priority: 0.35, refDistance: 3, maxDistance: 45,
    rateJitter: 0.12,
    layers: [
      nz({ attack: 0.0006, decay: 0.09, gain: 0.6,
           filter: { type: 'lowpass', freq: 2600, freqEnd: 700, Q: 0.8 } }),
      os({ wave: 'sine', freq: 160, freqEnd: 70, attack: 0.001, decay: 0.07, gain: 0.3 }),
      nz({ wave: 'pink', delay: 0.01, attack: 0.004, decay: 0.14, gain: 0.14,
           filter: { type: 'highpass', freq: 2800, Q: 0.7 } }),
    ],
  },
  impact_metal: {
    category: 'impact', gain: 0.6, priority: 0.35, refDistance: 3, maxDistance: 50,
    rateJitter: 0.15, tail: { send: 0.18, time: 0.3 },
    layers: [
      nz({ attack: 0.0004, decay: 0.03, gain: 0.45,
           filter: { type: 'highpass', freq: 3200, Q: 0.8 } }),
      os({ wave: 'triangle', freq: 2400, freqEnd: 2350, attack: 0.0005, decay: 0.35,
           gain: 0.3, filter: { type: 'bandpass', freq: 2400, Q: 12 } }),
      os({ wave: 'sine', freq: 3700, freqEnd: 3650, attack: 0.0005, decay: 0.22, gain: 0.18 }),
      os({ wave: 'sine', freq: 5200, attack: 0.0005, decay: 0.12, gain: 0.1 }),
    ],
  },
  impact_grate: {
    category: 'impact', gain: 0.55, priority: 0.35, refDistance: 3, maxDistance: 40,
    rateJitter: 0.15,
    layers: [
      nz({ attack: 0.0005, decay: 0.05, gain: 0.45,
           filter: { type: 'bandpass', freq: 1800, Q: 2 } }),
      os({ wave: 'square', freq: 420, freqEnd: 380, attack: 0.001, decay: 0.18, gain: 0.22,
           filter: { type: 'bandpass', freq: 900, Q: 8 } }),
      os({ wave: 'square', freq: 1300, freqEnd: 1180, delay: 0.01, attack: 0.001,
           decay: 0.14, gain: 0.16, filter: { type: 'bandpass', freq: 1300, Q: 10 } }),
    ],
  },
  impact_glass: {
    category: 'impact', gain: 0.6, priority: 0.4, refDistance: 3, maxDistance: 45,
    rateJitter: 0.18,
    layers: [
      nz({ attack: 0.0003, decay: 0.06, gain: 0.5,
           filter: { type: 'highpass', freq: 4000, Q: 0.8 } }),
      os({ wave: 'sine', freq: 5400, freqEnd: 5200, attack: 0.0004, decay: 0.28, gain: 0.2 }),
      os({ wave: 'sine', freq: 7200, freqEnd: 6900, attack: 0.0004, decay: 0.2, gain: 0.14 }),
      os({ wave: 'triangle', freq: 3100, attack: 0.0004, decay: 0.16, gain: 0.12 }),
      nz({ delay: 0.05, attack: 0.01, decay: 0.35, gain: 0.16,
           filter: { type: 'highpass', freq: 5000, Q: 0.7 } }),
    ],
  },
  impact_flesh: {
    category: 'impact', gain: 0.6, priority: 0.5, refDistance: 3, maxDistance: 35,
    rateJitter: 0.12,
    layers: [
      nz({ attack: 0.0008, decay: 0.05, gain: 0.55,
           filter: { type: 'lowpass', freq: 1400, freqEnd: 400, Q: 0.9 } }),
      os({ wave: 'sine', freq: 220, freqEnd: 60, attack: 0.001, decay: 0.09, gain: 0.4 }),
      nz({ wave: 'pink', delay: 0.01, attack: 0.003, decay: 0.08, gain: 0.25,
           filter: { type: 'bandpass', freq: 700, Q: 1.2 } }),
    ],
  },
  impact_water: {
    category: 'impact', gain: 0.55, priority: 0.3, refDistance: 3, maxDistance: 35,
    rateJitter: 0.15,
    layers: [
      os({ wave: 'sine', freq: 900, freqEnd: 260, attack: 0.001, decay: 0.07, gain: 0.35 }),
      nz({ delay: 0.005, attack: 0.004, decay: 0.22, gain: 0.3,
           filter: { type: 'highpass', freq: 1800, freqEnd: 4200, Q: 0.7 } }),
      nz({ wave: 'pink', delay: 0.02, attack: 0.02, decay: 0.3, gain: 0.16,
           filter: { type: 'bandpass', freq: 2600, Q: 0.7 } }),
    ],
  },

  // --- Footsteps -----------------------------------------------------------
  footstep_concrete: {
    category: 'foot', gain: 0.4, priority: 0.15, refDistance: 2, maxDistance: 22,
    rateJitter: 0.14, gainJitter: 0.15,
    layers: [
      nz({ attack: 0.002, decay: 0.055, gain: 0.4,
           filter: { type: 'lowpass', freq: 1600, freqEnd: 500, Q: 0.8 } }),
      os({ wave: 'sine', freq: 120, freqEnd: 60, attack: 0.002, decay: 0.05, gain: 0.22 }),
    ],
  },
  footstep_metal: {
    category: 'foot', gain: 0.4, priority: 0.15, refDistance: 2, maxDistance: 26,
    rateJitter: 0.14, gainJitter: 0.15,
    layers: [
      nz({ attack: 0.001, decay: 0.04, gain: 0.4,
           filter: { type: 'bandpass', freq: 2200, Q: 1.6 } }),
      os({ wave: 'triangle', freq: 1300, freqEnd: 1200, attack: 0.001, decay: 0.12,
           gain: 0.16, filter: { type: 'bandpass', freq: 1300, Q: 9 } }),
      os({ wave: 'sine', freq: 320, freqEnd: 260, attack: 0.001, decay: 0.06, gain: 0.2 }),
    ],
  },
  footstep_grate: {
    category: 'foot', gain: 0.4, priority: 0.15, refDistance: 2, maxDistance: 26,
    rateJitter: 0.14, gainJitter: 0.15,
    layers: [
      nz({ attack: 0.001, decay: 0.05, gain: 0.4,
           filter: { type: 'bandpass', freq: 1500, Q: 2.2 } }),
      os({ wave: 'square', freq: 620, freqEnd: 560, attack: 0.001, decay: 0.09, gain: 0.14,
           filter: { type: 'bandpass', freq: 700, Q: 7 } }),
      os({ wave: 'square', freq: 980, freqEnd: 900, delay: 0.012, attack: 0.001,
           decay: 0.07, gain: 0.1, filter: { type: 'bandpass', freq: 1000, Q: 8 } }),
    ],
  },
  footstep_water: {
    category: 'foot', gain: 0.4, priority: 0.15, refDistance: 2, maxDistance: 22,
    rateJitter: 0.14, gainJitter: 0.15,
    layers: [
      nz({ attack: 0.004, decay: 0.13, gain: 0.4,
           filter: { type: 'highpass', freq: 900, freqEnd: 3000, Q: 0.7 } }),
      nz({ wave: 'pink', delay: 0.015, attack: 0.01, decay: 0.16, gain: 0.2,
           filter: { type: 'bandpass', freq: 1800, Q: 0.8 } }),
      os({ wave: 'sine', freq: 400, freqEnd: 180, attack: 0.001, decay: 0.05, gain: 0.12 }),
    ],
  },

  // --- Player body ---------------------------------------------------------
  jump: {
    category: 'body', gain: 0.4, priority: 0.3, refDistance: 2, maxDistance: 18,
    layers: [
      nz({ wave: 'pink', attack: 0.006, decay: 0.1, gain: 0.25,
           filter: { type: 'bandpass', freq: 1200, freqEnd: 2400, Q: 0.8 } }),
      os({ wave: 'triangle', freq: 180, freqEnd: 260, attack: 0.01, decay: 0.1, gain: 0.15,
           filter: { type: 'lowpass', freq: 900, Q: 0.8 } }),
    ],
  },
  land: {
    category: 'body', gain: 0.55, priority: 0.35, refDistance: 2, maxDistance: 24,
    layers: [
      nz({ attack: 0.002, decay: 0.09, gain: 0.5,
           filter: { type: 'lowpass', freq: 1200, freqEnd: 300, Q: 0.8 } }),
      os({ wave: 'sine', freq: 140, freqEnd: 48, attack: 0.002, decay: 0.13, gain: 0.4 }),
      nz({ wave: 'pink', delay: 0.01, attack: 0.004, decay: 0.12, gain: 0.16,
           filter: { type: 'bandpass', freq: 900, Q: 0.9 } }),
    ],
  },
  player_hurt: {
    category: 'voice', gain: 0.6, priority: 0.85, refDistance: 1, maxDistance: 10,
    rateJitter: 0.09,
    layers: [
      os({ wave: 'sawtooth', freq: 300, freqEnd: 160, attack: 0.004, decay: 0.16, gain: 0.3,
           filter: { type: 'lowpass', freq: 1200, freqEnd: 500, Q: 1 } }),
      nz({ wave: 'pink', attack: 0.006, decay: 0.24, gain: 0.28,
           filter: { type: 'bandpass', freq: 700, freqEnd: 300, Q: 0.8 } }),
      os({ wave: 'sine', freq: 90, freqEnd: 60, attack: 0.002, decay: 0.2, gain: 0.25 }),
    ],
  },
  player_death: {
    category: 'voice', gain: 0.75, priority: 1, refDistance: 1, maxDistance: 10,
    rateJitter: 0, tail: { send: 0.35, time: 0.9 },
    layers: [
      os({ wave: 'sawtooth', freq: 220, freqEnd: 48, attack: 0.02, decay: 1.4, gain: 0.35,
           filter: { type: 'lowpass', freq: 1400, freqEnd: 180, Q: 1 } }),
      os({ wave: 'sine', freq: 110, freqEnd: 32, attack: 0.02, decay: 1.6, gain: 0.3 }),
      nz({ wave: 'pink', attack: 0.05, decay: 1.2, gain: 0.2,
           filter: { type: 'lowpass', freq: 900, freqEnd: 160, Q: 0.8 } }),
    ],
  },

  // --- Enemies -------------------------------------------------------------
  enemy_alert: {
    category: 'voice', gain: 0.65, priority: 0.9, refDistance: 4, maxDistance: 48,
    rateJitter: 0.08,
    layers: [
      os({ wave: 'sawtooth', freq: 180, freqEnd: 220, attack: 0.02, hold: 0.06, decay: 0.22,
           gain: 0.4, filter: { type: 'bandpass', freq: 780, freqEnd: 1100, Q: 3 } }),
      os({ wave: 'sawtooth', freq: 182, freqEnd: 224, attack: 0.025, hold: 0.05, decay: 0.2,
           gain: 0.22, filter: { type: 'bandpass', freq: 1200, Q: 4 } }),
      nz({ wave: 'pink', attack: 0.01, decay: 0.2, gain: 0.1,
           filter: { type: 'bandpass', freq: 1600, Q: 1.2 } }),
    ],
  },
  enemy_fire: {
    category: 'weapon', gain: 0.7, priority: 0.8, refDistance: 5, maxDistance: 85,
    rolloff: 1.05, rateJitter: 0.07, tail: { send: 0.26, time: 0.34 },
    layers: [
      nz({ attack: 0.0006, hold: 0.003, decay: 0.075, gain: 0.75,
           filter: { type: 'highpass', freq: 700, freqEnd: 320, Q: 0.9 } }),
      nz({ attack: 0.0003, decay: 0.028, gain: 0.5,
           filter: { type: 'bandpass', freq: 2200, freqEnd: 1000, Q: 1.5 } }),
      os({ wave: 'square', freq: 160, freqEnd: 52, attack: 0.001, decay: 0.1, gain: 0.4,
           filter: { type: 'lowpass', freq: 620, Q: 0.8 } }),
      nz({ wave: 'brown', delay: 0.035, attack: 0.012, decay: 0.4, gain: 0.26,
           filter: { type: 'lowpass', freq: 1200, freqEnd: 260, Q: 0.7 } }),
    ],
  },
  enemy_hurt: {
    category: 'voice', gain: 0.55, priority: 0.6, refDistance: 3, maxDistance: 34,
    rateJitter: 0.1,
    layers: [
      os({ wave: 'sawtooth', freq: 240, freqEnd: 150, attack: 0.01, decay: 0.18, gain: 0.32,
           filter: { type: 'bandpass', freq: 700, Q: 3 } }),
      nz({ wave: 'pink', attack: 0.008, decay: 0.16, gain: 0.14,
           filter: { type: 'bandpass', freq: 1400, Q: 1 } }),
    ],
  },
  enemy_death: {
    category: 'voice', gain: 0.65, priority: 0.75, refDistance: 3, maxDistance: 40,
    rateJitter: 0.07, tail: { send: 0.2, time: 0.4 },
    layers: [
      os({ wave: 'sawtooth', freq: 210, freqEnd: 70, attack: 0.02, decay: 0.7, gain: 0.32,
           filter: { type: 'bandpass', freq: 600, freqEnd: 260, Q: 2.5 } }),
      nz({ wave: 'pink', attack: 0.02, decay: 0.6, gain: 0.16,
           filter: { type: 'lowpass', freq: 1200, freqEnd: 300, Q: 0.8 } }),
      nz({ delay: 0.55, attack: 0.004, decay: 0.22, gain: 0.35,
           filter: { type: 'lowpass', freq: 900, freqEnd: 220, Q: 0.8 } }),
      os({ wave: 'sine', freq: 120, freqEnd: 45, delay: 0.55, attack: 0.002, decay: 0.2,
           gain: 0.28 }),
    ],
  },
  enemy_reload: {
    category: 'mech', gain: 0.4, priority: 0.3, refDistance: 3, maxDistance: 28,
    rateJitter: 0.08,
    layers: [
      os({ wave: 'square', freq: 1200, freqEnd: 800, attack: 0.0005, decay: 0.025,
           gain: 0.22, filter: { type: 'bandpass', freq: 1500, Q: 3 } }),
      nz({ delay: 0.09, attack: 0.001, decay: 0.04, gain: 0.22,
           filter: { type: 'highpass', freq: 2000, Q: 0.8 } }),
      os({ wave: 'square', freq: 300, freqEnd: 170, delay: 0.22, attack: 0.001, decay: 0.06,
           gain: 0.22, filter: { type: 'lowpass', freq: 1100, Q: 0.9 } }),
    ],
  },

  // --- Feedback / UI -------------------------------------------------------
  hitmarker: {
    category: 'ui', gain: 0.4, priority: 0.7,
    layers: [
      os({ wave: 'square', freq: 1800, attack: 0.0004, decay: 0.035, gain: 0.28,
           filter: { type: 'bandpass', freq: 1900, Q: 3 } }),
      os({ wave: 'sine', freq: 2700, attack: 0.0004, decay: 0.025, gain: 0.14 }),
    ],
  },
  hitmarker_crit: {
    category: 'ui', gain: 0.45, priority: 0.75,
    layers: [
      os({ wave: 'square', freq: 2300, attack: 0.0004, decay: 0.03, gain: 0.3,
           filter: { type: 'bandpass', freq: 2400, Q: 3 } }),
      os({ wave: 'square', freq: 3100, delay: 0.035, attack: 0.0004, decay: 0.045,
           gain: 0.26, filter: { type: 'bandpass', freq: 3200, Q: 3 } }),
      os({ wave: 'sine', freq: 4600, delay: 0.035, attack: 0.0004, decay: 0.03, gain: 0.12 }),
    ],
  },
  objective_complete: {
    category: 'music', gain: 0.55, priority: 0.9, tail: { send: 0.3, time: 0.5 },
    layers: [
      os({ wave: 'triangle', freq: 523.25, attack: 0.005, decay: 0.28, gain: 0.22 }),
      os({ wave: 'triangle', freq: 659.25, delay: 0.11, attack: 0.005, decay: 0.3, gain: 0.22 }),
      os({ wave: 'triangle', freq: 783.99, delay: 0.22, attack: 0.005, decay: 0.5, gain: 0.24 }),
      os({ wave: 'sine', freq: 1567.98, delay: 0.22, attack: 0.005, decay: 0.4, gain: 0.08 }),
    ],
  },
  checkpoint: {
    category: 'music', gain: 0.4, priority: 0.6, tail: { send: 0.22, time: 0.35 },
    layers: [
      os({ wave: 'sine', freq: 880, attack: 0.004, decay: 0.22, gain: 0.16 }),
      os({ wave: 'sine', freq: 1174.66, delay: 0.09, attack: 0.004, decay: 0.3, gain: 0.14 }),
    ],
  },
  alarm_siren: {
    category: 'alarm', gain: 0.5, priority: 0.95, loop: true, refDistance: 8,
    maxDistance: 120, rolloff: 0.7, rateJitter: 0,
    layers: [
      os({ wave: 'sawtooth', freq: 620, freqEnd: 930, attack: 0.05, hold: 0.3, decay: 0.45,
           gain: 0.3, filter: { type: 'bandpass', freq: 900, Q: 2 } }),
      os({ wave: 'square', freq: 310, freqEnd: 465, attack: 0.05, hold: 0.3, decay: 0.45,
           gain: 0.16, filter: { type: 'lowpass', freq: 1400, Q: 0.9 } }),
    ],
  },
  ui_click: {
    category: 'ui', gain: 0.35, priority: 0.5,
    layers: [
      os({ wave: 'square', freq: 1200, attack: 0.0004, decay: 0.028, gain: 0.2,
           filter: { type: 'bandpass', freq: 1400, Q: 2 } }),
      nz({ attack: 0.0003, decay: 0.012, gain: 0.1,
           filter: { type: 'highpass', freq: 4000, Q: 0.8 } }),
    ],
  },
  ui_hover: {
    category: 'ui', gain: 0.2, priority: 0.2, rateJitter: 0,
    layers: [os({ wave: 'sine', freq: 1500, attack: 0.001, decay: 0.05, gain: 0.09 })],
  },
  ui_confirm: {
    category: 'ui', gain: 0.4, priority: 0.6,
    layers: [
      os({ wave: 'triangle', freq: 740, attack: 0.002, decay: 0.09, gain: 0.16 }),
      os({ wave: 'triangle', freq: 1108, delay: 0.07, attack: 0.002, decay: 0.16, gain: 0.16 }),
    ],
  },
  ui_deny: {
    category: 'ui', gain: 0.4, priority: 0.6,
    layers: [
      os({ wave: 'square', freq: 260, attack: 0.002, decay: 0.08, gain: 0.16,
           filter: { type: 'lowpass', freq: 900, Q: 0.9 } }),
      os({ wave: 'square', freq: 180, delay: 0.09, attack: 0.002, decay: 0.14, gain: 0.18,
           filter: { type: 'lowpass', freq: 700, Q: 0.9 } }),
    ],
  },

  // --- World interaction ---------------------------------------------------
  interact_start: {
    category: 'mech', gain: 0.4, priority: 0.4, refDistance: 2, maxDistance: 20,
    layers: [
      os({ wave: 'sawtooth', freq: 90, freqEnd: 200, attack: 0.02, decay: 0.2, gain: 0.16,
           filter: { type: 'lowpass', freq: 700, freqEnd: 1500, Q: 2 } }),
      nz({ wave: 'pink', attack: 0.02, decay: 0.22, gain: 0.08,
           filter: { type: 'bandpass', freq: 1200, Q: 1 } }),
    ],
  },
  interact_complete: {
    category: 'mech', gain: 0.45, priority: 0.55, refDistance: 2, maxDistance: 22,
    layers: [
      os({ wave: 'sawtooth', freq: 200, freqEnd: 80, attack: 0.01, decay: 0.18, gain: 0.16,
           filter: { type: 'lowpass', freq: 1500, freqEnd: 500, Q: 2 } }),
      os({ wave: 'square', freq: 640, freqEnd: 380, delay: 0.16, attack: 0.001, decay: 0.07,
           gain: 0.2, filter: { type: 'bandpass', freq: 1000, Q: 3 } }),
    ],
  },
  breaker_pull: {
    category: 'mech', gain: 0.7, priority: 0.8, refDistance: 2, maxDistance: 32,
    tail: { send: 0.2, time: 0.3 },
    layers: [
      nz({ attack: 0.002, decay: 0.08, gain: 0.45,
           filter: { type: 'bandpass', freq: 800, freqEnd: 400, Q: 1.4 } }),
      os({ wave: 'square', freq: 180, freqEnd: 90, attack: 0.002, decay: 0.12, gain: 0.4,
           filter: { type: 'lowpass', freq: 600, Q: 0.9 } }),
      nz({ delay: 0.1, attack: 0.0006, decay: 0.05, gain: 0.35,
           filter: { type: 'highpass', freq: 3500, Q: 0.8 } }),
      nz({ delay: 0.105, attack: 0.001, decay: 0.09, gain: 0.18,
           filter: { type: 'bandpass', freq: 5200, Q: 1 } }),
      os({ wave: 'sine', freq: 70, freqEnd: 40, delay: 0.1, attack: 0.002, decay: 0.2,
           gain: 0.25 }),
    ],
  },
  powerdown: {
    category: 'mech', gain: 0.7, priority: 0.9, refDistance: 6, maxDistance: 90,
    rolloff: 0.6, rateJitter: 0, tail: { send: 0.35, time: 0.8 },
    layers: [
      os({ wave: 'sawtooth', freq: 220, freqEnd: 28, attack: 0.02, decay: 1.8, gain: 0.3,
           filter: { type: 'lowpass', freq: 1600, freqEnd: 120, Q: 1.5 } }),
      os({ wave: 'sine', freq: 110, freqEnd: 18, attack: 0.02, decay: 2, gain: 0.25 }),
      nz({ wave: 'pink', attack: 0.05, decay: 1.5, gain: 0.14,
           filter: { type: 'lowpass', freq: 1200, freqEnd: 90, Q: 0.8 } }),
    ],
  },
  heli_approach: {
    category: 'ambient', gain: 0.6, priority: 0.85, refDistance: 12, maxDistance: 160,
    rolloff: 0.5, rateJitter: 0, tail: { send: 0.25, time: 0.6 },
    layers: [
      nz({ wave: 'brown', attack: 0.4, hold: 1.2, decay: 1.4, gain: 0.3,
           filter: { type: 'lowpass', freq: 400, freqEnd: 900, Q: 1.2 } }),
      os({ wave: 'sawtooth', freq: 900, freqEnd: 1500, attack: 0.6, hold: 1, decay: 1.2,
           gain: 0.12, filter: { type: 'bandpass', freq: 1400, freqEnd: 2200, Q: 3 } }),
      os({ wave: 'sine', freq: 22, freqEnd: 28, attack: 0.4, hold: 1.2, decay: 1.2,
           gain: 0.3, filter: { type: 'lowpass', freq: 200, Q: 0.9 },
           am: { rate: 11, depth: 0.9 } }),
    ],
  },

  // --- Mission stingers ----------------------------------------------------
  mission_success: {
    category: 'music', gain: 0.6, priority: 1, tail: { send: 0.35, time: 0.9 },
    layers: [
      os({ wave: 'triangle', freq: 261.63, attack: 0.08, hold: 0.4, decay: 1.2, gain: 0.18 }),
      os({ wave: 'triangle', freq: 329.63, delay: 0.05, attack: 0.08, hold: 0.4, decay: 1.2,
           gain: 0.16 }),
      os({ wave: 'triangle', freq: 392, delay: 0.1, attack: 0.08, hold: 0.4, decay: 1.4,
           gain: 0.16 }),
      os({ wave: 'sine', freq: 523.25, delay: 0.3, attack: 0.05, hold: 0.3, decay: 1.4,
           gain: 0.12 }),
      nz({ wave: 'pink', attack: 0.3, decay: 1.2, gain: 0.05,
           filter: { type: 'bandpass', freq: 2000, Q: 0.6 } }),
    ],
  },
  mission_fail: {
    category: 'music', gain: 0.6, priority: 1, tail: { send: 0.35, time: 0.9 },
    layers: [
      os({ wave: 'sawtooth', freq: 196, attack: 0.06, hold: 0.3, decay: 1.4, gain: 0.18,
           filter: { type: 'lowpass', freq: 1000, freqEnd: 300, Q: 1 } }),
      os({ wave: 'sawtooth', freq: 155.56, delay: 0.25, attack: 0.06, hold: 0.3, decay: 1.6,
           gain: 0.18, filter: { type: 'lowpass', freq: 900, freqEnd: 250, Q: 1 } }),
      os({ wave: 'sine', freq: 98, delay: 0.5, attack: 0.08, decay: 1.8, gain: 0.2 }),
    ],
  },
};

/**
 * The two ambient bed layers. They are looping textures rather than one-shots, so the
 * engine builds them with a dedicated code path (`setAmbientState`) instead of the
 * voice pool — but they are still described here so their design stays with the rest
 * of the sound bank and remains inspectable from tests.
 */
const AMBIENT_BANK = {
  ambient_sea: {
    category: 'ambient', gain: 0.55, loop: true, priority: 0.1, rateJitter: 0,
    layers: [
      nz({ wave: 'brown', attack: 2, hold: 60, decay: 2, gain: 0.8,
           filter: { type: 'lowpass', freq: 240, Q: 0.7 } }),
      nz({ wave: 'pink', attack: 3, hold: 60, decay: 3, gain: 0.16,
           filter: { type: 'bandpass', freq: 1400, Q: 0.5 } }),
    ],
  },
  ambient_hum: {
    category: 'ambient', gain: 0.45, loop: true, priority: 0.1, rateJitter: 0,
    layers: [
      os({ wave: 'sawtooth', freq: 58, attack: 2, hold: 60, decay: 2, gain: 0.5,
           filter: { type: 'lowpass', freq: 260, Q: 1.4 } }),
      os({ wave: 'square', freq: 116, attack: 2.5, hold: 60, decay: 2.5, gain: 0.18,
           filter: { type: 'lowpass', freq: 400, Q: 1.2 } }),
      os({ wave: 'sine', freq: 1180, attack: 4, hold: 60, decay: 4, gain: 0.03 }),
    ],
  },
};

const DESCRIPTORS = new Map();
for (const [name, spec] of Object.entries(BANK)) {
  DESCRIPTORS.set(name, makeDescriptor(name, spec));
}
for (const [name, spec] of Object.entries(AMBIENT_BANK)) {
  DESCRIPTORS.set(name, makeDescriptor(name, spec));
}

/**
 * Every one-shot sound name the engine can play, in bank order. The two ambient bed
 * layers (`AMBIENT_LAYERS`) are deliberately not listed here — they are continuous
 * textures driven by `setAmbientState`, not things gameplay triggers by name.
 */
export const SOUNDS = Object.freeze(Object.keys(BANK));

/** Names of the looping ambient bed layers, describable but not in `SOUNDS`. */
export const AMBIENT_LAYERS = Object.freeze(Object.keys(AMBIENT_BANK));

/**
 * Look up a sound descriptor.
 *
 * Returns the shared deep-frozen descriptor object (no allocation, safe to call in the
 * hot path). **Unknown names return `null`** — callers must handle it; the engine logs
 * the attempt and plays nothing rather than substituting a placeholder.
 *
 * @param {string} name
 * @returns {object|null}
 */
export function describe(name) {
  if (typeof name !== 'string') return null;
  return DESCRIPTORS.get(name) || null;
}

/** All descriptors, including the ambient layers, as a frozen name → descriptor map. */
export function describeAll() {
  return Object.fromEntries(DESCRIPTORS);
}

/**
 * Structural check used by the unit suite and by `describe`-time development. Returns
 * an array of human-readable problems; an empty array means the descriptor is sound.
 */
export function validateDescriptor(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (typeof d.name !== 'string' || !d.name) p.push('name must be a non-empty string');
  if (!BUSES.includes(d.bus)) p.push(`bus "${d.bus}" not one of ${BUSES}`);
  if (!(d.gain > 0) || d.gain > 1) p.push(`gain ${d.gain} out of (0,1]`);
  if (!(d.pan >= -1 && d.pan <= 1)) p.push(`pan ${d.pan} out of [-1,1]`);
  if (!(d.priority >= 0 && d.priority <= 1)) p.push(`priority ${d.priority} out of [0,1]`);
  if (!(d.duration > 0)) p.push(`duration ${d.duration} must be > 0`);
  if (!(d.peak > 0)) p.push(`peak ${d.peak} must be > 0`);
  if (!(d.refDistance > 0)) p.push('refDistance must be > 0');
  if (!(d.maxDistance >= d.refDistance)) p.push('maxDistance must be >= refDistance');
  if (!(d.rolloff >= 0)) p.push('rolloff must be >= 0');
  if (!Array.isArray(d.layers) || d.layers.length === 0) {
    p.push('layers must be a non-empty array');
    return p;
  }
  if (d.tail) {
    if (!(d.tail.send >= 0 && d.tail.send <= 1)) p.push('tail.send out of [0,1]');
    if (!(d.tail.time >= 0)) p.push('tail.time must be >= 0');
  }
  d.layers.forEach((l, i) => {
    const at = `layer ${i}`;
    if (l.type !== 'osc' && l.type !== 'noise') p.push(`${at}: bad type "${l.type}"`);
    if (l.type === 'osc') {
      if (!WAVES.includes(l.wave)) p.push(`${at}: bad wave "${l.wave}"`);
      if (!(l.freq >= MIN_FREQ)) p.push(`${at}: freq ${l.freq} below ${MIN_FREQ}`);
      if (!(l.freqEnd >= MIN_FREQ)) p.push(`${at}: freqEnd ${l.freqEnd} below ${MIN_FREQ}`);
    } else {
      if (!NOISE_COLORS.includes(l.wave)) p.push(`${at}: bad noise colour "${l.wave}"`);
      if (!(l.rate > 0)) p.push(`${at}: rate must be > 0`);
    }
    if (!(l.duration > 0)) p.push(`${at}: duration must be > 0`);
    if (!(l.attack >= 0)) p.push(`${at}: attack must be >= 0`);
    if (!(l.hold >= 0)) p.push(`${at}: hold must be >= 0`);
    if (!(l.decay > 0)) p.push(`${at}: decay must be > 0`);
    if (!(l.delay >= 0)) p.push(`${at}: delay must be >= 0`);
    if (l.attack + l.hold + l.decay > l.duration + 1e-9) {
      p.push(`${at}: envelope ${l.attack + l.hold + l.decay}s exceeds duration ${l.duration}s`);
    }
    if (l.delay + l.duration > d.duration + 1e-9) {
      p.push(`${at}: ends at ${l.delay + l.duration}s, past sound duration ${d.duration}s`);
    }
    if (!(l.gain >= 0 && l.gain <= 1)) p.push(`${at}: gain ${l.gain} out of [0,1]`);
    if (l.filter) {
      if (!FILTER_TYPES.includes(l.filter.type)) p.push(`${at}: bad filter type`);
      if (!(l.filter.freq >= MIN_FREQ)) p.push(`${at}: filter freq too low`);
      if (!(l.filter.freqEnd >= MIN_FREQ)) p.push(`${at}: filter freqEnd too low`);
      if (!(l.filter.Q > 0)) p.push(`${at}: filter Q must be > 0`);
    }
    if (l.am) {
      if (!(l.am.rate > 0)) p.push(`${at}: am.rate must be > 0`);
      if (!(l.am.depth >= 0 && l.am.depth <= 1)) p.push(`${at}: am.depth out of [0,1]`);
    }
  });
  return p;
}

/**
 * Stable fingerprint of a descriptor's synthesis, used by the unit suite to prove that
 * no two sounds in the bank would render identically.
 */
export function fingerprint(d) {
  if (!d) return '';
  const layers = d.layers.map((l) =>
    [
      l.type, l.wave, l.freq, l.freqEnd, l.rate, l.delay,
      l.attack, l.hold, l.decay, l.gain, l.curve,
      l.filter ? `${l.filter.type}:${l.filter.freq}:${l.filter.freqEnd}:${l.filter.Q}` : '-',
      l.am ? `${l.am.rate}:${l.am.depth}` : '-',
    ].join(','),
  );
  return `${d.gain}|${d.pan}|${d.tail ? `${d.tail.send}:${d.tail.time}` : '-'}|${layers.join(';')}`;
}
