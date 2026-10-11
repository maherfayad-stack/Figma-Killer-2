import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { readReasonCodes } from './src/__tests__/architecture/helpers/refusalSentences'
const test = readFileSync('src/__tests__/architecture/refusal-copy-shape.test.ts', 'utf8')
const structured = [...test.matchAll(/^  (\/\^.*\/),$/gm)].map((m) => eval(m[1]!) as RegExp)
const files = execSync('git ls-files src server', { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__/') && !/\.test\./.test(f))
const codes = new Set<string>()
for (const f of files) if (structured.some((p) => p.test(f))) for (const c of readReasonCodes(f, readFileSync(f, 'utf8'))) codes.add(c)
console.log(codes.size)
if (process.argv[2]) console.log([...codes].sort().join(' '))
