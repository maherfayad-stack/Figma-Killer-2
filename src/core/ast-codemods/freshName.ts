/**
 * freshName — the one policy for "the name I wanted is already taken": keep it
 * when it is free, otherwise append the first number (`Card2`, `Card3`, ...)
 * that nothing uses. Every codemod that names something NEW (a component, a
 * slot prop, a hoisted binding, a carried declaration) asks here instead of
 * refusing, so a name collision is never the reason a gesture does nothing.
 *
 * Pure: the caller says what "taken" means (a file on disk, a binding in
 * scope, an identifier anywhere in a file), because that is the one thing that
 * differs between callers and the one thing a shared helper cannot know.
 */
export function freshName(preferred: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(preferred)) return preferred
  for (let n = 2; ; n += 1) {
    const candidate = `${preferred}${n}`
    if (!isTaken(candidate)) return candidate
  }
}
