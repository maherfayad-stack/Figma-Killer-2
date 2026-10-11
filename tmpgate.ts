import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { copyViolation, readRefusalSentences, readSentenceLiterals, stringConstantsOf } from './src/__tests__/architecture/helpers/refusalSentences'
const test = readFileSync('src/__tests__/architecture/refusal-copy-shape.test.ts', 'utf8')
const structured = [...test.matchAll(/^  (\/\^.*\/),$/gm)].map((m) => eval(m[1]!) as RegExp)
const sentenceFiles = new Set([...test.matchAll(/^  '([^']+\.tsx?)',$/gm)].map((m) => m[1]!))
const files = execSync('git ls-files src server', { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__/') && !/\.test\./.test(f))
const shared = stringConstantsOf('x', readFileSync('src/core/utils/refusalCopy.ts', 'utf8'))
let n = 0
for (const f of files) {
  if (!structured.some((p) => p.test(f))) continue
  const src = readFileSync(f, 'utf8')
  const read = readRefusalSentences(f, src, shared)
  const all = sentenceFiles.has(f) ? [...read, ...readSentenceLiterals(f, src, new Set(read.map((s) => s.line)))] : read
  for (const s of all) { n++; const why = copyViolation(s.text, { remedyIsAction: s.remedyIsAction === true }); if (why) console.log(`${s.file}:${s.line} [${s.reason}] ${why}\n   ${s.text}`) }
}
console.error(n)
