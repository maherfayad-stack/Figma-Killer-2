// Demo: the core thesis, end to end, on a real page.
//  1. parse a React page into an editable tree
//  2. show which nodes are editable vs LOCKED (dynamic / rendered in code)
//  3. edit a prop -> watch it get written back into the .tsx source
// Run:  bun studio-demos/parse-and-edit.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePageFile } from '../src/core/page-parser/index.ts'
import { setJsxProp } from '../src/core/ast-codemods/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'studio-demo-'))
const file = join(dir, 'Home.tsx')

const page = `import { Button } from '@alm-design/design-system'

export default function Home() {
  return (
    <div>
      <h1>Welcome</h1>
      <Button label="Sign in" variant="primary" />
      {items.map((it) => (
        <Button key={it.id} label={it.label} />
      ))}
    </div>
  )
}
`
writeFileSync(file, page)

console.log('=== Page parsed into an editable tree ===')
const parsed = parsePageFile(file, dir)
for (const n of Object.values(parsed.nodes)) {
  const props = Object.keys(n.props).length ? '  props=' + JSON.stringify(n.props) : ''
  const lock = n.locked ? `   [LOCKED: ${n.lockReason}]` : ''
  console.log(`  ${n.kind.padEnd(9)} <${n.name}>${props}${lock}`)
}

console.log('\n=== Edit the (editable) Sign-in Button label -> written to source ===')
const btn = Object.values(parsed.nodes).find((n) => n.name === 'Button' && !n.locked)
setJsxProp({ file, line: btn.loc.line, col: btn.loc.col, prop: 'label', value: 'Log in' })
console.log(readFileSync(file, 'utf8'))

rmSync(dir, { recursive: true, force: true })
