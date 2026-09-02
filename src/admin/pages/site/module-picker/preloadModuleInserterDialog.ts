/**
 * preloadModuleInserterDialog — warms `ModuleInserterDialog`'s chunk ahead of
 * a click. Split into its own file (rather than living beside the
 * `LazyModuleInserterDialog` component) because `react-refresh/only-export-
 * components` forbids a `.tsx` component file from also exporting a plain
 * function — mixing the two breaks Fast Refresh's boundary detection.
 *
 * Wire it to a trigger's `onPointerEnter`/`onFocus`. It is a plain
 * `import()`, not a second `lazy()`; the browser/bundler module cache dedupes
 * it against the `lazy()` call in `LazyModuleInserterDialog.tsx`, so this
 * does not reintroduce an eager import — nothing calls it on mount.
 */
export function preloadModuleInserterDialog() {
  void import('./ModuleInserterDialog')
}
