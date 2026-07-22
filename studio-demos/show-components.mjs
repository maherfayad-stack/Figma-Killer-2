// Demo: what components the tool discovers from the @alm-design/design-system
// npm package, and the prop schema (incl. enums) it will drive the inspector with.
// Run:  bun studio-demos/show-components.mjs
import { buildDesignSystemManifest } from '../src/core/design-system-manifest/index.ts'

const m = await buildDesignSystemManifest()
console.log(`Discovered ${m.components.length} components from @alm-design/design-system:\n`)
console.log(m.components.map((c) => c.name).join(', '))

console.log('\nExample prop schemas (enums in parentheses = a dropdown in the inspector):')
for (const name of ['Button', 'Chip', 'Accolade']) {
  const c = m.components.find((x) => x.name === name)
  if (!c) continue
  console.log(`\n${name}:`)
  for (const p of c.props) {
    console.log(`   - ${p.name}${p.enumValues ? '  (' + p.enumValues.join(' | ') + ')' : ''}`)
  }
}
