// `babel-core-7` is an npm alias of `@babel/core@7` (see reactCompilerPlugin.ts),
// which ships no types of its own. The options are the same in 7 and 8, so
// they come from the installed `@babel/core`; the result is Babel 7's own
// shape (as `@types/babel__core` 7 declares it).
declare module 'babel-core-7' {
  import type { TransformOptions } from '@babel/core'

  export type { TransformOptions }

  export interface BabelFileResult {
    code?: string | null
    map?: {
      version: number
      sources: string[]
      names: string[]
      sourceRoot?: string
      sourcesContent?: string[]
      mappings: string
      file: string
    } | null
  }

  export function transformAsync(code: string, options?: TransformOptions): Promise<BabelFileResult | null>
  export function transformSync(code: string, options?: TransformOptions): BabelFileResult | null
}
