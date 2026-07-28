# GAME_SPEC.md — *Operation Undercurrent* (UC_GAME_001)

**Deliverable:** a playable first-person shooter **vertical slice** that runs in a
desktop browser on Three.js + WebGL2, from main menu to mission completion, with no
external asset downloads at runtime.

**Vertical slice** here means: one mission, played start to finish, with every system
that the full game would need present in shippable-quality form — not a gray box, not
a tech demo. Content breadth is deliberately narrow; system depth is not.

---

## 1. Premise & fiction

Undercurrent Station is a tidal-power substation on a fogged-in coastline. It has been
seized by a private security contractor who is using its grid uplink to exfiltrate
data. The player is a lone operator inserted at the dock. Objective: cut the security
grid, pull the data core, and reach the helipad before the contractor's reaction team
seals the facility.

Tone: cold, industrial, overcast dusk. Wet concrete, sodium lamps, sea fog, red alarm
strobes once detected.

---

## 2. Target platform & budgets

| Item | Target |
|---|---|
| Runtime | Chromium-based desktop browser, WebGL2 |
| Renderer | Three.js `WebGLRenderer`, `sRGB` output, ACES-filmic tonemapping |
| Simulation rate | Fixed 60 Hz, decoupled from render, max 5 catch-up steps |
| Render rate | Uncapped / vsync |
| Draw calls | ≤ 260 per frame in the heaviest view |
| Triangles | ≤ 400 k per frame in the heaviest view |
| Active dynamic lights | ≤ 10 (shadow-casting ≤ 3) |
| CPU simulation cost | ≤ 4.0 ms/frame average on a 2020-class laptop CPU core |
| JS heap after 3 min of play | ≤ 220 MB, with no unbounded growth trend |
| Bundle (gzip, excl. Three.js) | ≤ 220 kB |
| First interactive | ≤ 3 s from page load on localhost |
| External runtime requests | **zero** — all geometry, textures, and audio are generated procedurally in-engine |

Because the verification environment renders through SwiftShader (software WebGL),
GPU-side frame time measured in CI is a pessimistic bound and must be reported as
such. CPU simulation time, draw-call counts, triangle counts, and heap behaviour are
hardware-independent and are the binding budgets.

---

## 3. Mission structure — "Undercurrent"

Nine beats, all mandatory, playable in one continuous session:

1. **Main menu** — title, Start Mission, Settings, Controls. Live 3D backdrop.
2. **Briefing** — objective list, map callouts, loadout, "Deploy".
3. **Dock approach** *(objective 1: reach the substation)* — teaches movement, no
   combat pressure. One scripted patrol visible but avoidable.
4. **Pump hall** *(objective 2: cut power to the security grid)* — first firefight,
   3 enemies, cover-based. Player pulls two breaker levers.
5. **Server room** *(objective 3: retrieve the data core)* — 3 enemies, tighter space,
   introduces the shotgun pickup. Hold interact on the core for 4 s.
6. **Alarm** — taking the core trips the alarm. Lighting shifts to red strobe, siren
   audio, reaction team spawns.
7. **Catwalk fighting withdrawal** *(objective 4: reach the helipad)* — 5 enemies
   across the exterior catwalks, running battle.
8. **Extraction hold** *(objective 5: hold for extraction, 45 s)* — defend the helipad
   against 6 enemies in three waves while the timer runs.
9. **Results screen** — time, accuracy, shots fired, kills, damage taken, objectives,
   grade. Replay / return to menu.

**Fail state:** player health reaches 0 → death screen with Retry (restarts at the
last checkpoint) and Return to Menu. Checkpoints fire on each objective completion.

---

## 4. Systems

### 4.1 Player controller
- Pointer-lock mouselook; yaw unlimited, pitch clamped to ±89°.
- Ground speed 5.2 m/s walk, 8.0 m/s sprint, 2.6 m/s crouch.
- Acceleration 60 m/s² grounded, 8 m/s² airborne; ground friction 10 /s when idle,
  reduced to 35% of that while a movement key is held (full friction against a
  60 m/s² accelerator caps ground speed at 6 m/s and makes the sprint unreachable),
  with a hard clamp to the current stance's top speed.
- Jump apex 1.1 m; gravity 22 m/s²; coyote time 100 ms; jump buffer 120 ms.
- Capsule collision (radius 0.35 m, height 1.8 m standing / 1.0 m crouched) resolved by
  **collide-and-slide** against static AABB colliders, 4 iterations.
- Step-up ≤ 0.45 m without losing speed; slope limit 50°.
- Head bob amplitude scaling with planar speed; landing dip; ADS suppresses bob by 80%.
- Crouch transitions over 120 ms with headroom check before standing.

### 4.2 Weapons
Two weapons, both hitscan, switchable with `1`/`2` and the mouse wheel.

| | **MX-4 Carbine** (start) | **Breacher-12 Shotgun** (pickup, server room) |
|---|---|---|
| Fire mode | Full-auto | Pump, 1 shell/shot |
| RPM | 620 | 70 |
| Damage | 22 body / 55 head, falloff to 60% past 30 m | 12 × 9 pellets, falloff to 30% past 14 m |
| Magazine | 30 | 6 |
| Reserve | 180 | 36 |
| Reload | 2.1 s (1.6 s tactical) | 0.55 s/shell, interruptible |
| Base spread | 0.35° hip / 0.06° ADS | 3.6° cone |
| Recoil | 0.55° vertical/shot with horizontal jitter, 8 /s recovery | 3.2° kick |
| ADS | 0.22 s, FOV 78° → 55° | 0.18 s, FOV 78° → 68° |

Shared: per-shot spread growth and decay, recoil pattern applied to camera and
recovered smoothly, muzzle flash + light, shell ejection, tracer for 1 in 3 shots,
surface-typed impact decals and particle bursts, hitmarker (white body / red critical),
and distinct audio for fire, reload stages, empty click, and impact.

### 4.3 Enemies
Six-state FSM: `IDLE → PATROL → SUSPICIOUS → COMBAT → SEARCH → DEAD`.

- **Perception:** 100° horizontal FOV cone, 32 m range, requires unbroken raycast to
  head or torso. Awareness accumulates over 0.45 s of continuous sight (0.15 s if the
  target is firing or sprinting), decays over 3 s. Gunshots create audio stimuli with
  a 25 m radius that push nearby enemies to SUSPICIOUS.
- **Navigation:** waypoint graph per zone with A* over the graph, plus local steering
  and obstacle avoidance; enemies strafe between cover nodes and never bunch closer
  than 1.6 m.
- **Combat:** burst fire with 0.35–0.9 s inter-burst pauses, 2–5 rounds per burst,
  accuracy degrading with player movement and range, deliberate first-shot miss on
  initial engagement (grace shot), suppression-driven cover swapping every 3–6 s.
- **Damage:** 100 HP, headshot ×2.5, limb ×0.75, hit flinch, directional death impulse,
  ragdoll-lite death animation, corpse fade after 20 s.
- **Budget:** ≤ 8 simultaneously active enemies; 18 total across the mission
  (1 dock + 3 pump hall + 3 server room + 5 catwalks + 6 extraction).

### 4.4 Objectives & mission director
Data-driven objective list. Each objective has a type
(`reach` / `interact` / `interact-hold` / `survive-timer` / `eliminate`), a world
marker, a HUD entry, and completion/failure hooks. The director owns checkpoints,
enemy spawning per beat, the alarm state, and the results tally.

### 4.5 HUD & UI
Crosshair (dynamic, spread-driven, hit feedback), health + armour bars, ammo readout,
weapon list, objective tracker with distance, compass strip, damage-direction
indicators, low-health vignette, interaction prompts, subtitle/callout line,
kill/objective toasts. Menu, briefing, pause, settings, death, and results screens.

Settings persist to `localStorage`: mouse sensitivity, invert Y, FOV, master/SFX/music
volume, motion-blur-ish effects toggle, head-bob toggle, colourblind-safe crosshair,
reduced-flash mode (respects `prefers-reduced-motion`).

### 4.6 Audio
100% procedurally synthesized through the WebAudio API — no audio files. Weapon fire
(noise burst + filtered body + tail), reload clicks, impacts by surface type, enemy
vocalisations, footsteps by surface, alarm siren, UI clicks, and an adaptive two-layer
ambient bed (calm → alert). Positional panning via `PannerNode`; distance attenuation;
a limiter on the master bus.

### 4.7 Rendering
Procedural PBR-ish materials with generated noise/normal maps (concrete, steel, rust,
grating, glass, water), baked-feel lighting via a sky hemisphere + directional sun with
cascaded-feel shadow map, sodium lamp point lights with cheap volumetric-cone meshes,
sea fog, animated water plane, emissive alarm strobes, and a post chain (bloom,
vignette, film grain, chromatic aberration on damage, hurt flash).

---

## 5. Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| `Shift` | Sprint |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| LMB | Fire |
| RMB | Aim down sights |
| `R` | Reload |
| `1` `2` / wheel | Switch weapon |
| `E` | Interact (hold where indicated) |
| `Esc` | Pause |
| `F3` | Debug/perf overlay |

---

## 6. Determinism & test hooks

The build exposes `window.__UC` in dev and test builds:

- `__UC.state()` — snapshot of player, enemies, objectives, mission phase.
- `__UC.input(frame)` — inject a synthetic input frame (headless play).
- `__UC.step(ms)` — advance the fixed-step simulation deterministically.
- `__UC.seed(n)` — reseed the deterministic PRNG (all gameplay randomness routes
  through it; no bare `Math.random()` in simulation code).
- `__UC.teleport(x,y,z)`, `__UC.setPhase(name)` — test fixtures for beat isolation.
- `__UC.metrics()` — frame timings, draw calls, triangles, heap.

These hooks make the mission playable head­lessly and make the automated playthrough in
`tests/e2e/` a real playthrough rather than a screenshot tour.

---

## 7. Out of scope for the slice

Multiplayer, save slots beyond checkpoints, more than one mission, vehicles, gamepad
support, mobile/touch input, localisation, and imported artist-authored assets.
