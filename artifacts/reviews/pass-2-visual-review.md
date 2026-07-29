# Visual review — pass 2

**Agent:** fresh `visual-review` specialist, given only screenshots and the mission
context, no source access.
**Input:** the 23-shot `beat-*` set captured after the pass-1 fixes, plus the two
HUD resolution shots.
**Asked for:** the three largest perceptual weaknesses, ranked by damage done.

---

## 1. A specular streak on the floor dominates every interior frame

**What the reviewer saw.** In every pump-hall and server-room capture the brightest
region of the image was a broad diagonal highlight lying across the floor, brighter
than the lamps, the objective marker and the enemies. It moved with the camera, so
it read as a lighting artifact rather than a wet patch.

**Verdict: valid.** Floor roughness was in the 0.55–0.7 band with a wide
`roughRange`, which under a PMREM environment map gives a large, low-frequency
specular lobe across a big flat surface.

**Actions taken**
- Floor materials raised to roughness 0.94–0.99 with a narrow `roughRange`, so the
  environment contribution is diffuse-dominated.
- Verified against a fresh interior capture (`artifacts/screenshots/_dbg-hall.png`)
  before moving on.

## 2. The alarm is a full-screen red wash, and it is the same signal as low health

**What the reviewer saw.** Quoted:

> A full-screen red wash flattens the entire back half of the game, and it is the
> same signal as low health … Delete the full-screen tint. Make the alarm a local
> light event … Restrict the screen-space alarm element to a red edge vignette with
> the inner ~60% of the frame untinted. Then give low health its own non-red
> signature — desaturation plus darkened corners with a slow pulse, no hue shift —
> so the two states are never confusable.

**Verdict: valid**, and pass 1 had under-corrected the same problem: the global tint
had only been softened, and the strobes were still bright enough (110 at a 14–16 m
radius) to repaint every surface in the second half of the mission.

**Actions taken**
- `RenderStack.setAlarmLighting()` no longer pushes fog, sky, sun and hemisphere
  toward red. It now only dims and slightly cools them (`hemi` −0.42, `sun` −0.62 at
  full alarm), so the alarm reads as the facility going to emergency lighting.
- Strobe point lights cut from `pulse * 110` to `pulse * 30` and their radii from
  14–16 m to 7–9 m, making them local pools instead of a flood.
- New `.alarm-vig` HUD layer: a red edge vignette, 14% of the width on each side and
  11% of the height top and bottom, leaving the inner ~72% of the frame untinted.
  It strobes at 1.15 s, or holds steady when `reducedFlash` is on.
- Low health changed from a red radial tint to a neutral treatment: near-black
  corners with a 2.6 s breath (`.vignette.hurt`) plus a `saturate(0.6)` filter on the
  canvas (`#view.lowhp`). No hue shift, so it cannot be mistaken for the alarm.
- Evidence: `beat-22-alarm-normal.png` / `beat-22-alarm-reduced-flash.png` /
  `beat-22-alarm-no-screen-effects.png` versus `beat-16-low-health.png`.

## 3. The first-person weapon is missing from the captures

**What the reviewer saw.** No viewmodel in any gameplay shot, including the one
labelled "aim down sights".

**Verdict: valid, and worse than reported.** Three separate faults, only the first of
which was a harness problem:

1. `beat()` cleared the input frame before screenshotting, so ADS decayed during the
   two settle frames. Fixed with a `hold` option that keeps a frame installed
   through the shot.
2. The weapon was genuinely almost off-screen. The model's origin sat at the
   receiver and it was held at z = −0.36 under a 58° view camera, which put the
   receiver at NDC y −0.90 (the very bottom edge) and the rear of the stock 9 cm
   from the camera — and *behind* it at ADS, where it ballooned into an unlit slab.
   Confirmed by projecting every viewmodel mesh to NDC via `tools/_probe.mjs`.
3. `weapon_body` was a dark grey (`0x4a5158`) that matched the floor it was drawn
   against, so what little was on screen had no contrast.

**Actions taken — viewmodel rebuilt (see FINAL_REPORT §Redesigns)**
- Held at z = −0.50 and scaled to 0.78, so the nearest geometry is ~29 cm out and
  the whole weapon is in frame.
- Yawed −0.20 rad at the hip, unwinding to square at ADS: end-on, a box-built gun is
  a flat slab with no recognisable silhouette.
- Iron sights rebuilt at a size that reads at 720p — a 21 mm rear aperture ring and
  a front post with a mint `emissive_green` tip — and the ADS height is now derived
  from the sight line rather than eyeballed, so the sights sit on the optical axis.
- Recoil impulses and the integrated spring are clamped (`MAX_KICK_VEL`,
  `MAX_KICK_BACK`, `MAX_KICK_UP`). Unclamped, a held trigger stacked 11 impulses a
  second and drove the weapon past the camera origin — it vanished for the whole
  burst, which is what the "missing viewmodel" looked like while firing.
- `weapon_body` lightened to `0x8b959f`, `weapon_dark` to `0x4d565f`, and hands moved
  to a dedicated `weapon_glove` material instead of borrowing `enemy_body`.
- Evidence: `_dbg-vm-hip.png`, `_dbg-vm-ads.png`, `_dbg-vm-fire.png`.
