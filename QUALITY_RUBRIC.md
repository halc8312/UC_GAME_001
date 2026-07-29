# QUALITY_RUBRIC.md — completion gate

Every criterion below must **pass** before the slice is called done. A criterion
passes only when the listed evidence exists in `artifacts/` and is cited by path in
`FINAL_REPORT.md`. "Looks right" is not evidence. An unrun test is a failure.

Status legend: `PASS` / `FAIL` / `PARTIAL` (with the shortfall named).

---

## A. Build & hygiene

| # | Criterion | Evidence required |
|---|---|---|
| A1 | `npm install` completes with 0 vulnerabilities and no missing peers | install log |
| A2 | `npm run build` succeeds; production bundle emitted | build log, `dist/` listing |
| A3 | App bundle (gzip, excluding Three.js) ≤ 220 kB | build size log |
| A4 | `npm run test` — full unit suite green, ≥ 90 tests | vitest output |
| A5 | `npm run test:e2e` — full Playwright suite green | Playwright output |
| A6 | Zero uncaught console errors during a complete playthrough | captured console log |
| A7 | Zero failed network requests; zero runtime requests to external hosts | captured network log |
| A8 | No `Math.random()` in `src/core/**` or `src/game/**` (determinism) | unit test result |
| A9 | Every Three.js resource created by a system is released by its `dispose()` | leak-check test result |

## B. Core gameplay

| # | Criterion | Evidence required |
|---|---|---|
| B1 | Pointer-lock mouselook with clamped pitch and persisted sensitivity | e2e assertion + screenshot |
| B2 | Movement: walk/sprint/crouch/jump at the spec'd speeds, ±5% | unit test on the controller |
| B3 | Collide-and-slide keeps the player inside the level from every reachable point | out-of-world sweep test |
| B4 | Step-up over 0.45 m obstacles without speed loss; 50° slope limit honoured | unit test |
| B5 | Both weapons fire, reload, ADS, switch, and run dry correctly | unit tests + e2e |
| B6 | Ballistics: falloff, spread growth, recoil accumulation and recovery per spec | unit tests |
| B7 | Hit registration on all hitboxes with correct damage multipliers | unit tests |
| B8 | Enemy FSM traverses all six states in a real encounter | e2e state-trace log |
| B9 | Enemy pathing reaches the player through the level without stalling | e2e nav trace |
| B10 | Enemies use cover, burst-fire, flinch, and die with feedback | screenshots + e2e |
| B11 | Player can die; death screen appears; retry restores the checkpoint | e2e |
| B12 | All 5 objectives complete in sequence and the mission ends in Results | e2e playthrough log |

## C. Mission & UX

| # | Criterion | Evidence required |
|---|---|---|
| C1 | Menu → briefing → mission → results reachable with no dead ends | screenshots of each screen |
| C2 | Pause menu suspends simulation and resumes cleanly | e2e assertion |
| C3 | Settings change behaviour and persist across reload | e2e assertion |
| C4 | Objective tracker always states the current goal and its distance | screenshots |
| C5 | Damage feedback: direction indicator, vignette, audio, screen shake | screenshots |
| C6 | Results screen reports accurate time, accuracy, kills, damage, grade | e2e comparison against the simulation's own tally |
| C7 | Controls documented in-game and matching the implementation | screenshot |
| C8 | Reduced-flash / reduced-motion mode suppresses strobes and shake | screenshot pair |

## D. Presentation

| # | Criterion | Evidence required |
|---|---|---|
| D1 | Every mission beat is legible: the player can always tell where to go | one screenshot per beat (≥ 9) |
| D2 | Lighting reads as a coherent scene — no flat ambient wash, no black holes | screenshots |
| D3 | Materials are distinguishable by surface type at gameplay distance | screenshot |
| D4 | Weapon viewmodel is animated: sway, bob, recoil, reload, ADS | screenshot set |
| D5 | Combat is readable: muzzle flash, tracers, impacts, hitmarkers, enemy tells | combat screenshots |
| D6 | Alarm state visibly and audibly changes the facility | before/after screenshot pair |
| D7 | HUD is readable at 1280×720 and 1920×1080 without overlap | screenshot at both sizes |
| D8 | Three independent visual-review passes end with no blocking weakness | review notes in `artifacts/reviews/` |

## E. Audio

| # | Criterion | Evidence required |
|---|---|---|
| E1 | Weapon, impact, footstep, enemy, alarm, and UI audio all fire from the graph | audio-event log from a real run |
| E2 | Audio is positional and attenuates with distance | unit test on the mixer |
| E3 | Master limiter prevents clipping when many voices overlap | unit test |
| E4 | No audio file is fetched at runtime | network log |

## F. Performance & stability

| # | Criterion | Evidence required |
|---|---|---|
| F1 | CPU simulation ≤ 4.0 ms/frame average during the heaviest encounter | perf JSON |
| F2 | Draw calls ≤ 260 and triangles ≤ 400 k in the heaviest view | perf JSON |
| F3 | Frame-time distribution captured with p50/p95/p99, software-render caveat stated | perf JSON + report |
| F4 | JS heap ≤ 220 MB after 3 minutes and not trending upward | memory samples |
| F5 | 3-minute soak with continuous combat produces no errors and no leak | soak log |
| F6 | Full playthrough completes unattended with no blocker bug | e2e log |

## G. Documentation

| # | Criterion | Evidence required |
|---|---|---|
| G1 | `FINAL_REPORT.md` lists exact commands and their observed results | the report |
| G2 | Every artifact referenced by path and present in the repository | the report + `artifacts/` |
| G3 | Limitations and known issues stated plainly, not omitted | the report |
| G4 | Redesigns (subsystems rebuilt after 3 failed correction passes) recorded | the report |
| G5 | README explains how to run, test, and play | `README.md` |
