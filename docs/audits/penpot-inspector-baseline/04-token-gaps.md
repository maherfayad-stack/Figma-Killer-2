# 04 — Token gaps

`src/styles/globals.css:236-270`'s `--inspector-*` tokens are commented as
modeling **Figma's** inspector row, explicitly never measured against
anything (`panel-20`'s own "Done so far" already flagged this before this
audit started). This file supersedes that rationale with real, measured
Penpot `2.17.2` numbers. It does not edit `globals.css` — per the work
order, P0 is research-only, zero files under `src/`. This is the punch list
for whoever executes P1/P3.

## Existing token vs. measured Penpot value

| Token | Current value (Figma-guess) | Measured Penpot value | Verdict |
|---|---|---|---|
| `--inspector-row-h` | `24px` | `32px` | **Gap.** Off by a third. Every field row, and the tab bar, measure `32px` in Penpot — see `02-measurements.md`. |
| `--inspector-header-h` | `32px` | `32px` | **Match.** Keep as-is. |
| `--inspector-field-radius` | `5px` | `8px` | **Gap.** Measured directly off the field wrapper's `border-radius` in both themes. |
| `--inspector-field-gap` | `6px` | not a single comparable number — see below | **Needs re-derivation, not a straight swap.** |
| `--inspector-label-w` | `68px` (a text-label column width) | **the concept doesn't transfer** — see below | **Conceptual gap**, not numeric. |
| `--inspector-rail-w` | `32px` | n/a — Penpot has no icon rail | **Obsolete once P1 lands.** `StyleCategoryRail` is one of the things `STUDIO-LIVE-CANVAS-PLAN.md` §4.0 names as "chrome that costs a click or a glance and buys nothing"; Penpot's own panel confirms the rail has no counterpart to measure against. Delete this token with the rail, don't try to re-measure it. |
| `--inspector-pad-x` | `8px` | `12px` (panel's own horizontal content padding) | **Gap.** |
| `--inspector-space-*` scale | a 2–12px `4xs`…`xl` ramp | Penpot uses exactly two gap sizes in practice: `4px` (within a tightly related row pair) and `16px` (between row groups) | **Simplify, don't port 1:1.** A nine-step scale is solving a problem Penpot's actual rhythm doesn't have — see `02-measurements.md` → "Row rhythm." |

## New tokens needed (nothing existing to compare against)

Penpot's accent color is **not one color** — it changes hue between themes,
not just lightness, and Studio's current two-layer color model
(`docs/design.md`) doesn't have a slot for "the one color the inspector's
own active-tab/selection-ring uses, which is different per theme by design."

| Proposed token | Dark value | Light value | Where it's used in Penpot |
|---|---|---|---|
| `--inspector-accent` (name TBD by whoever lands P1 — pick something that reads as identity, not decoration, per this repo's color rules) | `#7EFFF5` (teal) | `#6911D4` (purple) | Active Design/Prototype/Inspect tab text, selection outline on canvas, focused-field outline |
| `--inspector-field-bg` (redefine, not reuse `--overlay-5`) | `#212426` | `#F3F4F6` | Every numeric/text field's own background, independent of the panel background |
| `--inspector-section-label-color` | `#8F9DA3` | `#495E74` | Section header text (`FILL`, `STROKE`, …) |

**Before inventing new token names**, check whether any of these three
already have a close match in `globals.css`'s existing achromatic/accent
vocabulary (`--text-muted`, `--bg-surface-2`, an existing numbered
`--accent-N`) — this audit did not cross-reference against the full token
sheet exhaustively, only confirmed that the *current* `--inspector-*`
tokens don't cover them. That cross-check is P1's job, not P0's.

## The label-column concept doesn't survive contact with Penpot

`--inspector-label-w: 68px` assumes a field has a **text label** ("Line
height", "Letter spacing") in a fixed-width column beside it — that's
Figma's shape, and it's what the token's own comment says it's modeling. **Penpot
does not do this.** Every field in Penpot's Design panel is labeled by a
**16×16 icon glyph** (an `X`, a corner-radius icon, a padding icon, …), not
by text. There is no 68px column to measure, because there is no text
label to put in it. Two ways P3 could resolve this — pick one, don't guess:

1. Adopt Penpot's icon-glyph model wholesale (matches this baseline's own
   fixture screenshots exactly, and is what "Two fields per row … label as a
   one-letter mark that is also the scrub handle" in `STUDIO-LIVE-CANVAS-PLAN.md`
   §P2 rule 5 already describes — that rule was written before this audit
   but happens to already match Penpot's real behavior).
2. Keep a text-label column for accessibility/clarity reasons Studio cares
   about that Penpot doesn't — in which case `68px` is still a guess and
   needs its own measurement against whatever real labels get chosen
   (`W`, `H`, `X`, `Y`, `Rotation`, `Radius` at `12-14px` font is unlikely to
   need `68px` — that width was almost certainly sized for a longer Figma
   label like "Corner radius" that Penpot's model never spells out at all).

Either way, `68px` un-examined is wrong; this baseline does not pick the
resolution because that is a P1/P3 design decision, not a P0 measurement.

## Field-gap and space-scale: simplify, don't 1:1 port

The nine-step `--inspector-space-4xs` … `--inspector-space-xl` scale (2px
through 12px) was built to give Figma's denser rhythm room to express
itself. Penpot's actual measured rhythm (`02-measurements.md` → "Row
rhythm") only ever uses **two** gap values in the areas this audit walked:
`4px` (icon-to-input within one field; also the gap between two tightly
paired rows like Rotation/Radius) and `16px` (between distinct row groups
like the W/H pair and the X/Y pair). Whether Penpot's Fill/Stroke/Shadow
list rows (not walked in this fixture set — F1's Fill/Stroke sections were
single-entry) introduce a third gap value is unmeasured; check when P3
reaches those sections rather than assuming the two-value rhythm holds
everywhere.

## Radius scale note

Studio's global radius scale (`CLAUDE.md` → "Border radius scale") already
has an `--input-radius: 1em` (pill) and a `--radius: 6px` (default control).
Penpot's measured field radius, `8px`, matches **neither** exactly. Given
this repo's existing scale is a deliberate, gated system
(`css-token-policy.test.ts` et al.), the right move for P1 is almost
certainly **reusing `--radius` (6px) or defining one new
`--inspector-field-radius: 8px`**, not bending the global scale to fit one
number pulled from a different product. Flagging the choice, not making it.
