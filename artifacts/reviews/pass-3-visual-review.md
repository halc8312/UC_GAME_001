# Visual review — pass 3

**Agent:** fresh art-direction / readability reviewer, given only the mission
premise and 19 PNGs, explicitly barred from reading source.
**Input:** the `beat-*` set captured after the pass-2 fixes.
**Asked for:** the three largest perceptual weaknesses, ranked, plus three yes/no
questions on weapon legibility, alarm-vs-health separation, and wayfinding.

Every claim below was checked against the images and the code before anything was
changed. Two were wrong; they are recorded as wrong rather than quietly acted on.

---

## 1. Screen-state feedback is inverted — the alarm takes the frame, near-death gets nothing

**What the reviewer saw.** The alarm edge vignette saturated the outer third of
`beat-12`, `beat-13` and `beat-22-alarm-normal` and bled into the play space,
while the world itself barely changed. The decisive evidence was an A/B at one
camera position: in `beat-22-alarm-reduced-flash` two contractors are plainly
readable mid-left; in `beat-22-alarm-normal`, same camera, the same two are
dissolved into the red. Meanwhile `beat-16` at HP 26 read as a full-health frame.

> The effect that is supposed to say "you are in danger" is the thing preventing
> you from seeing the danger.

**Verdict: valid, and the most damaging finding of the three.** Pass 2 had moved
the alarm out of a global tint and into an edge vignette, but made that vignette
14% of the width per side at 0.55 alpha — wide and strong enough to eat exactly
the part of the frame where enemies appear. The low-health treatment added in the
same pass was real (`saturate(0.6)` plus dark corners; the muted tanks in
`beat-16` versus the vivid ones in `beat-15` show it firing) but far too subtle
to notice without an A/B, so "zero screen treatment" is an overstatement of a
correct observation.

**Actions taken — the two systems swapped channels, as the reviewer proposed**
- The alarm now lives in the *world*. `LevelBuilder.updateAlarm()` drives every
  sodium lamp toward emergency red (`0xff3b1c`) and drops it 42%, recolouring its
  bulb mesh to match. Every surface in a room changes without costing a pixel of
  enemy contrast.
- The screen layer is now a hint, not a wash: sides 14% → 7% at 0.34 alpha,
  top/bottom 11% → 5% at 0.20, and the pulse floor raised from 0.30 to 0.55 so
  the state never reads as "off" between beats — which is what made
  `beat-11-alarm-catwalk` look alarm-free.
- Low health rebuilt as a two-grade escalation: `hurt` below 45 HP (dark corners,
  `saturate(0.52)`, 2.4 s breath) and `hurt crit` below 22 HP (near-black corners,
  `saturate(0.28)`, 1 s pulse). Still no hue shift — red stays the alarm's.

**Also actioned from this finding:** the reviewer noted no muzzle flash, tracer,
hitmarker or damage indicator in *any* capture. That was a harness fault — the
combat beats fired and then stepped 700–900 ms of simulation before shooting the
screenshot, by which time every transient had expired. `engage()` now advances
only 24 ms after firing, and a dedicated `beat-14b-muzzle-flash` capture exists.

## 2. ADS is blind — the sight picture is an opaque block with no reticle

**Verdict: mixed. Two of the three sub-claims are valid; the third is factually
wrong.**

- *"No aperture, no front post."* **Wrong.** `beat-15-ads.png` does contain the
  rear aperture ring at frame centre with the mint front tip inside it. It is,
  however, small enough that a reviewer scanning at speed missed it — which for a
  sight picture is the same as not being there.
- *"The crosshair is removed entirely."* **Valid.** At `adsFactor > 0.85` the
  whole reticle including the centre dot was hidden.
- *"ADS doesn't magnify."* **Wrong.** The carbine goes 78° → 55° on ADS, a 30%
  cut, validated by a `weapondefs` assertion that rejects `fovAds >= fovHip`. The
  shotgun's 78° → 68° is deliberately mild.
- *"The shotgun has the same silhouette as the carbine, only lighter grey."*
  **Valid.**

**Actions taken**
- Aperture ring 21 mm → 27 mm; sight towers raised (`SIGHT_Y` 0.062 → 0.076),
  which also drops the receiver further below the optical axis; ADS hold pushed
  from 0.50 m to 0.58 m, shrinking the on-screen body ~14%.
- The centre dot now survives ADS (arms fold, dot stays and grows to 3 px).
- Shotgun rebuilt to a distinct silhouette: barrel a quarter shorter, bore three
  times wider (36 mm vs 12 mm), a 44 mm choke ring, an exposed shell tube, and a
  chunky ribbed pump.

## 3. Props float unsupported and interpenetrate — and several floating props are red

**Verdict: two valid, one a misidentification that still points at a real defect.**

- *Exterior pendant lamps hang from nothing.* **Valid** — confirmed in
  `beat-13`, `beat-11`, `beat-22-*` and `beat-03`. Interior lamps hang from a
  ceiling; outdoors the stem terminated in open sky. Twelve exterior fixtures and
  the two exterior strobes now carry a `mast: [deckY, dx, dz]` and are built as
  pole-and-arm assemblies running down to the deck.
- *"Red wedge props clip through lamp shades and crates, including in `beat-16`
  where no alarm is active."* **Misidentified, but a real defect.** It is not
  geometry: it is the damage-direction indicator, a DOM triangle 128 px from the
  crosshair. A probe (`tools/_probe.mjs`) enumerated every red-albedo and
  red-emissive mesh within 26 m of the `beat-16` camera and found none. A HUD
  element that an experienced reviewer confidently reads as a shard of level
  geometry has failed at being a HUD element, so it was restyled: a wider, thinner
  double-tapered blade pushed out to 186 px with a glow and a soft gradient, so it
  can only read as an overlay.
- *`beat-08-breaker-prompt` is a blown-out tan field and the breaker is an
  untextured slab.* **Valid, and worse than reported — the breakers had no prop at
  all.** `INTERACTABLES` carried the two levers as pure data; the only geometry
  near them was a plain `steel` panel on the wall. An objective worth 2 of 5 was
  identified solely by its interact prompt. Each breaker is now a cabinet with a
  dark frame, hazard-striped top and bottom bands, a physical lever, and an amber
  status light that swings and goes dark when pulled
  (`LevelBuilder.setBreakerPulled()`, driven from `interact:complete`). The
  capture camera also backed off from 1.2 m to 2.2 m so a single sodium lamp no
  longer blows the wall out across the whole frame.

## Also actioned, from the closing note

Outside the numbered three, the reviewer observed that the server room spends cyan
(reserved for contractor markings) and mint (the HUD accent) on rack indicators and
room fill, so in that room neither reserved colour can do its job. Checked and
correct: the `screen` material emitted `0x2fd0ff` against `enemy_accent`'s
`0x66f2ff` — the same colour to any practical eye — across roughly forty rack
strips, and the data core's own point light was 26 units at a 9 m radius, which
flooded the whole room mint. Both were cheap, so both were fixed rather than
deferred: rack strips moved to indigo (`0x4f63e0`), core light cut to 13 units at
5.5 m so it pools on the objective instead of painting the room.

## A bug the review surfaced indirectly

Chasing "no muzzle flash in any capture" past the harness turned up a real defect.
`ImpactSystem.update()` ran *after* `_updateCamera()` in the render callback, so a
muzzle flash was spawned with 55 ms of life and then immediately charged the whole
frame's delta. Above ~18 fps it survived a frame or two; below that it was dead
before it was ever drawn — under SwiftShader, and on any weak machine, firing
produced no visible flash at all. Effects are now aged *before* the frame's update
spawns new ones, so anything spawned this frame is guaranteed to render at least
once.

## Reviewer's answers to the direct questions

- **Weapon legible?** "No — only in hip-fire." Actioned above.
- **Alarm distinguishable from low health?** "Yes, but only because low health has
  no treatment at all." Actioned above.
- **Wayfinding?** "Yes — a mint diamond waypoint with a label and metre distance
  is present and legible in all thirteen gameplay frames." No action needed; the
  contrast complaint against the red wash is resolved by finding 1.
