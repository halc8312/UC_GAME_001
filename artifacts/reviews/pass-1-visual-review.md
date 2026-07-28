# Visual review — pass 1

**Agent:** fresh `visual-review` specialist, given only screenshots and the mission
context, no source access.
**Input:** 14 gameplay captures plus 2 structural reference shots
(`wip-*` prefix, superseded by the `beat-*` set).
**Asked for:** the three largest perceptual weaknesses, ranked by damage done.

---

## 1. No atmosphere and no material story — reads as gray-box with glossy plastic props

**What the reviewer saw.** Large surfaces were flat single-colour albedo. Several
carried a blown-out streaky anisotropic highlight that read as polished chrome or an
oil slick — the crate lid, the pump-hall duct, and the pipe run were each the
brightest object in their frame, brighter than the lamps and brighter than the lit
doorway the player is meant to walk toward. Lamp fixtures floated with no mount.

**Verdict: mostly valid.** The chrome finding was correct and was the single most
damaging problem. The reviewer also claimed "there is no fog anywhere" — that is
wrong, `FogExp2` was present from the first build, but the density was low enough
that the perception was fair, so it was treated as a real signal.

**Actions taken**
- Environment IBL intensity cut from 0.55 to 0.26; every diffuse surface pushed to
  `metalness ≤ 0.18`, with genuine metal reserved for pipes and handrails.
- The brushed-metal streak amplitude was halved at the texture source rather than
  masked in the material.
- Fog density raised 0.0165 → 0.024 and the sky's bottom band recoloured to match,
  so the horizon dissolves instead of cutting.
- Hemisphere light raised and recoloured bluer so the sodium lamps read as warm
  *against* something.
- Concrete gained 4 m pour seams; `concrete`, `panel_wall` and `rubber_mat` had their
  value ranges widened after a unit test caught them below the flatness threshold.
- Every lamp gained a stem and a mounting plate.

## 2. Threats are invisible, and the alarm shares a colour with the damage vignette

**What the reviewer saw.** Contractors were hue- and value-matched to their
backgrounds. The alarm state flooded the frame with the same red as the low-health
vignette, so "facility alerted" and "about to die" were one signal.

**Verdict: valid.**

**Actions taken**
- Contractor base colour dropped to a dark charcoal-navy at `metalness 0.05`, and a
  new `enemy_accent` material — a saturated cyan used nowhere else in the palette —
  was added as a chest band and shoulder pips. The markings go dark on death so a
  corpse stops reading as a live threat.
- The alarm's global tint was pulled back twice (`0x50242a` → `0x5d4048` → `0x554653`)
  and the strobes were made local: intensity 320 → 110, radius 24–30 m → 14–16 m.
  Full-frame red now belongs to damage alone.
- Enemy muzzle flashes were already emitted; their reach was verified against the
  audio/event log rather than assumed.

## 3. HUD noise sits in the centre of the screen, and the hero prop is a white blob

**What the reviewer saw.** Pickup labels drawn through walls at eye level in the band
where enemies appear, in the same amber as the objective marker. Four toasts stacked
at once. The data core — the object the mission is named after — was a clipped pure
white slab with the interact prompt printed over it.

**Verdict: valid.**

**Actions taken**
- Pickup markers are now line-of-sight tested, desaturated to a grey-amber, faded by
  distance, drop their labels beyond 12 m, and fade to 28% inside the central 90 px.
  Saturated amber is reserved for the objective marker.
- Off-screen markers now ride a ring at their true bearing instead of being clamped
  to one screen edge, where they piled on top of each other.
- Toast queue capped at 2 with a shorter life.
- The data core was rebuilt as a dark `steel_dark` casing with an emissive seam and
  cap plus its own point light, instead of a fully emissive body that blew out to
  white under ACES.
- The death and results screens no longer crush the world behind them to black; they
  desaturate and lightly dim so the player can still see what killed them.

---

## Reviewer's overall verdict

> This currently reads as a well-structured gray-box prototype with a good HUD
> skeleton rather than a shippable vertical slice, and the single change that would
> move it furthest is adding exponential blue-grey fog plus killing the chrome
> speculars.

## Notes on reviewer accuracy

Two claims were factually wrong and were checked rather than acted on blindly:

- *"There is no fog anywhere."* Fog was present throughout. The density was raised
  anyway because the perception was reasonable evidence that it was not reading.
- *"Five of the fourteen captures are the OPERATOR DOWN modal."* True of those
  captures, but the cause was a capture-harness bug, not the game: `setSynthetic`
  merged input frames, so a `{fire:true}` frame silently inherited an earlier
  `{moveZ:1}` and walked the player into a railing and into enemy fire, and state
  then leaked between beats. Both were fixed — the input API now replaces rather
  than merges, and every beat re-enters from a checkpoint.
