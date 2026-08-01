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