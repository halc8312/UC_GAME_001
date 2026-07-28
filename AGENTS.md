# AGENTS.md — roles, delegation, and the verification process

This project is built by one **technical director** coordinating short-lived
specialist subagents. This file defines who does what, what a subagent is allowed to
touch, and — most importantly — what counts as proof that something works.

---

## 1. Roles

### technical-director (single, persistent)
Owns the repository, the architecture, the merge, and the final report. Writes the
integration code and anything that crosses subsystem boundaries. **All integration is
done by this role**; subagents never wire their own systems into the game loop.
Only this role may mark a rubric criterion as passing.

### systems specialists (parallel, short-lived)
Spawned for **independent** subsystems with a clearly bounded file list and a pure
interface. A systems specialist:
- receives an explicit file allowlist and an interface contract;
- writes the module plus its unit tests;
- must not edit files outside its allowlist, and must not edit shared entry points;
- returns a summary; the director reviews and integrates.

A subsystem qualifies for delegation only if it can be tested without a browser and
without the rest of the game (audio synthesis, procedural texture generation, the
navigation graph solver, ballistics math, the level data set, and so on). Anything
that touches the frame loop, the renderer instance, or global state stays with the
director.

### visual-review (per milestone, always a fresh agent)
Given only screenshots and the mission context — never the source — this agent names
**the three largest perceptual weaknesses** of the current build, ranked, each with a
concrete, actionable remedy. It is deliberately kept ignorant of the implementation so
its judgement is perceptual, not architectural. A new agent is spawned for each review
pass so it cannot anchor on its previous notes.

### qa (per milestone)
Runs the automated suites, plays the relevant beat headlessly, and reports failures
with reproduction steps. Never fixes what it finds.

---

## 2. Milestones

| ID | Milestone | Exit condition |
|---|---|---|
| M0 | Harness | App boots in headless Chromium, unit + e2e runners green, screenshots land in `artifacts/` |
| M1 | Core loop, controller, level | Whole level traversable without falling out of world; controller unit tests green |
| M2 | Weapons & combat feel | Both weapons fully functional with feedback; ballistics tests green |
| M3 | Enemy AI | Enemies perceive, path, fight, take damage, and die; FSM/nav tests green |
| M4 | Mission flow | Menu → briefing → all 5 objectives → results, headlessly, unattended |
| M5 | Presentation & audio | Visual review returns no blocking weakness; audio graph verified |
| M6 | Verification | Every rubric criterion passes with artifacts; FINAL_REPORT.md complete |

---

## 3. The per-milestone loop (mandatory, in order)

1. **Implement** the milestone.
2. **Build and run automated tests** — `npm run test` and `npm run build` must both
   succeed before proceeding. Record the command and its output.
3. **Play the relevant section in the browser** — a real headless Chromium session
   driving real input through the real game loop, not a unit test.
4. **Capture visual evidence** into `artifacts/screenshots/` with names that state
   the milestone and the beat.
5. **Visual review** — spawn a fresh `visual-review` agent on those captures; it
   returns exactly three ranked weaknesses.
6. **Fix** those three weaknesses.
7. **Regression** — re-run `npm run test`, `npm run build`, and `npm run test:e2e`.

**At most three correction passes per milestone.** If an area still fails on the third
pass, the subsystem is redesigned rather than tuned further, and the redesign is
recorded in FINAL_REPORT.md under "Redesigns".

---

## 4. Evidence rules

These are not negotiable and apply to every claim made in FINAL_REPORT.md.

1. **Never claim an unrun test passed.** A test result may only be reported if the
   command was executed in this session and its output observed. Report the exact
   command and the observed result.
2. **A criterion is complete only when an artifact proves it.** Screenshot, log,
   JSON metrics file, or test output committed under `artifacts/`. A criterion with
   no artifact path is, by definition, not complete.
3. **Measured, not estimated.** Performance numbers come from an instrumented run
   whose raw output is saved. Numbers derived under software rendering must be
   labelled as such.
4. **Failures are reported as failures.** A partially working system is described by
   what does not work, in the report, next to what does.
5. **Console must be clean.** Zero uncaught errors and zero failed network requests
   during the automated playthrough, evidenced by a captured console log.

---

## 5. Code conventions

- ES modules, no transpiler beyond Vite's default; no TypeScript in this slice.
- Simulation is deterministic: all gameplay randomness goes through the seeded PRNG in
  `src/core/rng.js`. `Math.random()` is banned in `src/game/**` and `src/core/**`
  (enforced by a unit test).
- Fixed-step simulation at 60 Hz; rendering interpolates. No gameplay logic in
  `requestAnimationFrame` callbacks.
- Zero per-frame allocation in hot paths: reuse scratch vectors, pool projectile
  effects, decals, particles, and audio voices.
- Every system exposes `update(dt, ctx)` and `dispose()`. Anything that creates a
  Three.js geometry, material, or texture must free it in `dispose()`.
- No runtime network requests. Textures and audio are generated in code.
- Unit-testable logic lives in pure modules that never import `three` where avoidable,
  so it can be tested in Node without a DOM.

---

## 6. Commands of record

```bash
npm install            # dependencies
npm run dev            # dev server on 127.0.0.1:5173
npm run build          # production build to dist/
npm run preview        # serve dist/ on 127.0.0.1:4173
npm run test           # vitest unit suite
npm run test:e2e       # Playwright: boot, playthrough, captures
npm run capture        # screenshot set into artifacts/screenshots/
npm run profile        # performance + memory run into artifacts/perf/
npm run verify         # test + build + e2e, the gate for "done"
```
