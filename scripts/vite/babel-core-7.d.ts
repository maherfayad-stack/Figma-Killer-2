// `babel-core-7` is an npm alias of `@babel/core@7` (see reactCompilerPlugin.ts).
// It ships no types of its own; the transform surface this repo uses is the
// same in 7 and 8, so it borrows the installed `@babel/core` declarations.
declare module 'babel-core-7' {
  export { transformAsync, transformSync, type TransformOptions } from '@babel/core'
}
