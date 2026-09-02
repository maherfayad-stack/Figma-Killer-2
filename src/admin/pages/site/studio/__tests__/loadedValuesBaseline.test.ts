/**
 * loadedValuesBaseline — `classIds` drift detection (Phase 0 item 0.6,
 * save-time seam).
 *
 * `collectClassIdsDrift` diffs every node's CURRENT `classIds` against the
 * load-time baseline; `commitClassIdsBaseline` advances that baseline so an
 * already-reported drift doesn't re-fire on the next autosave tick. These two
 * are the seam `fsCodemodAdapter.saveSite` calls into — see that file's own
 * "Phase 0 item 0.6" block.
 */
import { describe, it, expect } from 'bun:test'
import {
  collectClassIdsDrift,
  commitClassIdsBaseline,
  getLoadedClassIds,
  resetLoadedValues,
} from '../loadedValuesBaseline'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

function pageWithNode(nodeId: string, classIds: string[]) {
  return makePage({
    rootNodeId: 'root',
    nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [nodeId] }), [nodeId]: makeNode({ id: nodeId, moduleId: 'base.container', classIds }) },
  })
}

describe('loadedValuesBaseline — classIds drift (0.6)', () => {
  it('reports no drift for a node whose classIds are unchanged since load', () => {
    resetLoadedValues([pageWithNode('n1', ['card'])])
    expect(collectClassIdsDrift([pageWithNode('n1', ['card'])])).toEqual([])
  })

  it('reports an addition', () => {
    resetLoadedValues([pageWithNode('n1', [])])
    const drift = collectClassIdsDrift([pageWithNode('n1', ['card'])])
    expect(drift).toHaveLength(1)
    expect(drift[0].nodeId).toBe('n1')
    expect(drift[0].addedClassIds).toEqual(['card'])
    expect(drift[0].removedClassIds).toEqual([])
    expect(drift[0].reordered).toBe(false)
  })

  it('reports a removal', () => {
    resetLoadedValues([pageWithNode('n1', ['card'])])
    const drift = collectClassIdsDrift([pageWithNode('n1', [])])
    expect(drift).toHaveLength(1)
    expect(drift[0].addedClassIds).toEqual([])
    expect(drift[0].removedClassIds).toEqual(['card'])
    expect(drift[0].reordered).toBe(false)
  })

  it('reports a pure reorder (same set, different order) distinctly from add/remove', () => {
    resetLoadedValues([pageWithNode('n1', ['a', 'b'])])
    const drift = collectClassIdsDrift([pageWithNode('n1', ['b', 'a'])])
    expect(drift).toHaveLength(1)
    expect(drift[0].addedClassIds).toEqual([])
    expect(drift[0].removedClassIds).toEqual([])
    expect(drift[0].reordered).toBe(true)
  })

  it('never fires for a node newly created in this session with no classes', () => {
    resetLoadedValues([pageWithNode('n1', [])])
    expect(collectClassIdsDrift([pageWithNode('n1', []), pageWithNode('n2', [])])).toEqual([])
  })

  it('commitClassIdsBaseline advances the baseline so the same drift does not re-fire on the next tick', () => {
    resetLoadedValues([pageWithNode('n1', [])])
    const afterAdd = [pageWithNode('n1', ['card'])]
    expect(collectClassIdsDrift(afterAdd)).toHaveLength(1)

    commitClassIdsBaseline(afterAdd)
    expect(getLoadedClassIds('n1')).toEqual(['card'])
    // Unchanged since the commit — no more drift.
    expect(collectClassIdsDrift(afterAdd)).toEqual([])
  })

  it('resetLoadedValues (a fresh load) re-baselines classIds too, not just prop/style values', () => {
    resetLoadedValues([pageWithNode('n1', ['card'])])
    expect(getLoadedClassIds('n1')).toEqual(['card'])
    resetLoadedValues([pageWithNode('n1', [])])
    expect(getLoadedClassIds('n1')).toBeUndefined()
  })
})
