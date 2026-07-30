# design-system/ — the local ALM design-system source

This folder is where **ALM design-system components are authored locally**. It
replaced an empty git submodule that pointed at the same thing and carried no
content.

## What renders on the canvas today

Not this folder — the **published npm package**:

```
@alm-design/design-system@1.1.2      ← installed, 39 components
```

`src/modules/alm/register.tsx` imports that package and registers every
component in `src/modules/alm/manifest.generated.json` as an editor module
(`alm.Button`, `alm.Cell`, …). The manifest is produced by
`scripts/gen-alm-manifest.mjs`.

This folder currently ships **one** component (`Button`) plus the token layer.
It is a starting point, not a replacement — do not repoint the
`@alm-design/design-system` dependency at it until it reaches parity, or 38
components disappear from every imported board.

## Token shape

CSS custom properties (`src/tokens/tokens.css`) plus a plain JS mirror
(`src/tokens/tokens.ts`) — **not** W3C DTCG. Components are `Name.tsx` +
`Name.css` pairs. This mirrors the real Almosafer DS so it drops in cleanly.

## Where this is heading

`STUDIO-IMPORT-V2-PLAN.md` → **WS-3** replaces the hardcoded ALM path with
**generic per-project package modules**: any npm component package in an
imported repo gets a manifest and a browser bundle, and `src/modules/alm/` plus
`scripts/gen-alm-manifest.mjs` are deleted. When that lands, this folder stops
being special-cased and becomes just another project dependency.
