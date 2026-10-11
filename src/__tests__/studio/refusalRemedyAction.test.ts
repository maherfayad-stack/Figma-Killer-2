/**
 * G-11 - a save-time refusal that is a warning carries its remedy as an action.
 * A stale read says "Reload the project", so the button reloads it; any other
 * refusal that names a source position offers "Open in code".
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { reportClassTokenRefusals, reportEditRefusals, resetRefusalToasts } from '@site/studio/refusalToasts'

function latestToasts(): Toast[] {
  let latest: Toast[] = []
  subscribeToasts((snapshot) => {
    latest = [...snapshot]
  })
  return latest
}

beforeEach(() => {
  __resetToastBusForTests()
  resetRefusalToasts()
})

const NODE = 'src/App.tsx:4:5'

describe('a refusal warning carries its remedy action (G-11)', () => {
  it('a stale read offers "Reload project"', () => {
    for (const reason of ['stale-source', 'not-found', 'element-moved', 'template-not-found', 'component-not-found', 'list-changed']) {
      __resetToastBusForTests()
      resetRefusalToasts()
      reportEditRefusals([{ nodeId: NODE, kind: 'text', reason, message: 'The file changed on disk since the board read it. Reload the project and try again.' }])
      const [toast] = latestToasts()
      expect(toast?.kind, reason).toBe('warning')
      expect(toast?.action?.label, reason).toBe('Reload project')
    }
  })

  it('any other refusal that names a source position offers "Open in code"', () => {
    reportEditRefusals([{ nodeId: NODE, kind: 'text', reason: 'mixed-children', message: 'This element holds other elements next to its text. Change this text in the code.' }])
    const [toast] = latestToasts()
    expect(toast?.action?.label).toBe('Open in code')
  })

  it('a refusal with no source position has no button, and its sentence is the remedy', () => {
    reportEditRefusals([{ nodeId: 'css:rule', kind: 'css', reason: 'compiled-stylesheet', message: 'This is a minified build artefact, not hand-authored source. Edit the source it was built from.' }])
    const [toast] = latestToasts()
    expect(toast?.kind).toBe('warning')
    expect(toast?.action).toBeUndefined()
  })

  it('a class that could not be attached offers "Open in code" on its element', () => {
    reportClassTokenRefusals([
      { nodeId: NODE, nodeLabel: 'Button', className: 'primary', reason: 'styled-component-class', message: 'Edit the declarations inside the component.' },
    ])
    const [toast] = latestToasts()
    expect(toast?.action?.label).toBe('Open in code')
  })
})
