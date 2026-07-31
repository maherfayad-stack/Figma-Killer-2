/**
 * SlotControl — WS-6.5's `node`-kind PropKind affordance. Before this
 * control existed, `registerProjectModules.ts`'s `controlForKind` returned
 * `undefined` for `node` kind and the prop rendered no row at all.
 */
import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SlotControl } from '@site/property-controls/SlotControl'
import { studioSlotValue } from '@core/utils/studioSlotSentinel'
import { useEditorStore } from '@site/store/store'

describe('SlotControl', () => {
  it('renders an "Edit contents" button for a real slot sentinel', () => {
    render(
      <SlotControl
        propKey="icon"
        value={studioSlotValue('pages/Home.jsx:5:3')}
        label="Icon"
        onChange={() => {}}
      />,
    )
    expect(screen.getByTestId('slot-control-icon').textContent).toContain('Edit contents')
  })

  it('clicking "Edit contents" selects the slot node in the editor store', async () => {
    const user = userEvent.setup()
    const nodeId = 'pages/Home.jsx:5:3'
    render(
      <SlotControl
        propKey="icon"
        value={studioSlotValue(nodeId)}
        label="Icon"
        onChange={() => {}}
      />,
    )
    await user.click(screen.getByTestId('slot-control-icon'))
    expect(useEditorStore.getState().selectedNodeId).toBe(nodeId)
  })

  it('shows an empty state (not a broken button) for a non-sentinel value', () => {
    render(<SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} />)
    expect(screen.getByTestId('slot-control-icon-empty').textContent).toContain('no content in this slot')
    expect(screen.queryByTestId('slot-control-icon')).toBeNull()
  })
})
