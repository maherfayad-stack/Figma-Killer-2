# Studio design principles

Reviewed by design-critic — hierarchy, spacing rhythm, alignment,
contrast, and state coverage (empty, error, loading), not personal taste.

- Establish a clear visual hierarchy before adding detail — one primary
  action per screen, not three competing ones.
- Keep spacing on the project's own scale (see project-conventions.md)
  rather than inventing one-off values.
- Every interactive screen needs an empty state, an error state, and a
  loading state considered — even if the answer is "not applicable here".
- Contrast and touch-target size are not optional polish; call them out
  as findings, not suggestions, when they fail.

## Responsive by default — not a follow-up pass

A generated screen came back with `width: 375px` hardcoded on its root and
zero media queries in 233 lines. A board frame shows one device width; that
is the preview, never the specification.

- **Never put a fixed pixel width on a container.** Use `width: 100%` with
  a `max-width` cap, and let the frame decide the rest.
- Fixed `px` belongs only on things that genuinely do not scale — icon
  boxes, hairline borders, minimum touch targets.
- Prefer fluid values (`clamp()`, `%`, `rem`, `minmax()`) over a breakpoint
  whenever the layout can simply flex instead.
- Reach for a media query when the layout must genuinely CHANGE (a row
  becoming a column), not to restate a width you already hardcoded.

## Use the design system before writing CSS

A generated screen imported 2 components and hand-rolled a nav, a divider,
and three card rows in a local CSS module — every one of which already
existed in the installed design system.

- **Ask what exists before building it.** If the project ships a design
  system with an MCP server, query it (`list_components`, `find_component`)
  rather than reading its whole reference file — those files run to 100 KB
  and will fail the read-size limit.
- A local CSS module is for composing and positioning the system's
  components, not for re-implementing one of them.