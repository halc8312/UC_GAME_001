# Operation Undercurrent — UC_GAME_001

A first-person shooter **vertical slice** that runs in a desktop browser on Three.js
and WebGL2. One complete mission — dock infiltration, pump hall firefight, server
room, alarm, fighting withdrawal along exterior catwalks, and a timed extraction
hold — playable from the main menu to the results screen.

Everything is generated at runtime. There are no image files, no audio files, and no
model files in this repository: geometry, textures, normal/roughness maps and every
sound are synthesized in code, and the game makes **zero network requests** once the
page has loaded.

---

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Click the canvas to capture the pointer, then play. `Esc` releases the pointer and
opens the pause menu.

### Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| `Shift` | Sprint |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `R` | Reload |
| `1` `2` / wheel | Switch weapon |
| `E` | Interact (hold on the data core) |
| `Esc` | Pause |
| `F3` | Performance overlay |

---

## The mission

1. **Dock approach** — move up the pier and enter the substation.
2. **Pump hall** — first firefight; pull both breakers to cut the security grid.
3. **Server room** — pick up the Breacher-12, hold `E` on the data core.
4. **Alarm** — taking the core goes loud; the facility turns red and the reaction
   team deploys.
5. **Catwalks** — running battle out along the exterior walkways.
6. **Helipad** — hold for 45 seconds against three waves, then extract.

Checkpoints fire on every objective. Dying offers a retry from the last one.

---

## Commands

```bash
npm install        # dependencies (three is the only runtime dependency)
npm run dev        # dev server on 127.0.0.1:5173
npm run build      # production build into dist/
npm run preview    # serve the production build on 127.0.0.1:4173
npm run test       # vitest unit suite
npm run test:e2e   # Playwright: boot, real playthrough, HUD and accessibility checks
npm run capture    # screenshot every mission beat into artifacts/screenshots/
npm run profile    # performance + 3-minute memory soak into artifacts/perf/
npm run verify     # test + build + e2e — the gate for "done"
```

---

## How it is put together

```
src/
  core/      fixed-step loop, seeded PRNG, input, event bus, pools, metrics, settings
  engine/    renderer + environment, procedural textures, material library
  game/
    level/   collision (AABB + ramps, collide-and-slide), level data, mesh builder
    player/  movement controller, player state, first-person viewmodel
    weapons/ weapon definitions, ballistics maths, runtime weapon system, impact FX
    ai/      FSM, perception, navigation graph + A*, contractor model, manager
    combat/  hitboxes, damage, armour, fall damage
    mission/ objectives, mission director
  audio/     descriptor-based synthesis, WebAudio engine
  ui/        HUD, screen stack, styles
```

Simulation runs at a fixed 60 Hz and is fully decoupled from rendering. All gameplay
randomness goes through a seeded PRNG, so a seeded run reproduces exactly — which is
what lets the automated playthrough drive the real game rather than a stub.

The build exposes `window.__UC` for headless play (`state()`, `input()`, `step()`,
`metrics()`, …). The e2e suite injects command frames into the same input path the
mouse and keyboard use.

---

## Documents

- **[GAME_SPEC.md](GAME_SPEC.md)** — what the slice is, with the numbers the tests
  assert against.
- **[AGENTS.md](AGENTS.md)** — roles, the per-milestone loop, and the evidence rules.
- **[QUALITY_RUBRIC.md](QUALITY_RUBRIC.md)** — the completion gate.
- **[FINAL_REPORT.md](FINAL_REPORT.md)** — what was built, what was measured, the
  exact commands and their observed results, and the known limitations.

Evidence lives in `artifacts/`: `screenshots/`, `perf/`, `logs/`, `reviews/`.
