# Canonical JSX — quick reference

Full contract with examples: `docs/reference/canonical-jsx.md` in the
Studio installation. This file is a compact pointer, not a substitute —
read the full doc when you need the exact detection mechanism or a
non-example for a specific rule.

A screen is canonical when it has ZERO `violation`-tier findings — not
zero findings. Three of the ten rules (`literal-props`,
`static-class-name`, `no-wrapper-elements`) are `advisory` and fire on
legitimate, fully-canonical code too (a CSS-Modules `styles.x` usage
always trips `static-class-name`) — do not chase advisories to zero.

The ten rules, one line each: one `return`; props as literals or
module-scope consts; text as literal strings; `.map` only over a
module-scope const array; no spread props; a static `className`/`styles.x`;
one styling mechanism per file; inline `<svg>` stays static JSX;
components imported directly, never through a computed specifier; no
unnecessary wrapper elements added around content.