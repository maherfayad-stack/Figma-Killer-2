import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTree } from '@ccs/ast-engine';
import type { TreeSnapshotEvent } from '@ccs/protocol';
import { buildLiveTreeSnapshot, createTreeSnapshotStore } from './tree-snapshot.js';

const HERO_SOURCE = `export default function Hero() {
  return (
    <section>
      <h1>Hi</h1>
    </section>
  );
}
`;
const HERO_REL_PATH = 'src/frames/Hero.tsx';

describe('buildLiveTreeSnapshot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccs-tree-snapshot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the file off disk and returns a TreeNode byte-identical to buildTree on the same source', async () => {
    const abs = join(dir, 'Hero.tsx');
    await writeFile(abs, HERO_SOURCE);

    const tree = await buildLiveTreeSnapshot(abs, HERO_REL_PATH);
    expect(tree).toEqual(buildTree(HERO_SOURCE, HERO_REL_PATH));
  });

  it('fails soft (null) for a file that does not exist', async () => {
    const tree = await buildLiveTreeSnapshot(join(dir, 'Missing.tsx'), 'src/frames/Missing.tsx');
    expect(tree).toBeNull();
  });

  it('fails soft (null) for a source with no JSX root (buildTree would throw)', async () => {
    const abs = join(dir, 'Empty.tsx');
    await writeFile(abs, 'export default function Empty() { return null; }\n');
    const tree = await buildLiveTreeSnapshot(abs, 'src/frames/Empty.tsx');
    expect(tree).toBeNull();
  });
});

describe('createTreeSnapshotStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccs-tree-snapshot-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('computeAndCache populates currentEvents synchronously without invoking onRecomputed (project-open population, not a broadcast)', async () => {
    const abs = join(dir, 'Hero.tsx');
    await writeFile(abs, HERO_SOURCE);
    const events: TreeSnapshotEvent[] = [];
    const store = createTreeSnapshotStore({ onRecomputed: (e) => events.push(e), debounceMs: 20 });

    const tree = await store.computeAndCache(abs, HERO_REL_PATH);
    expect(tree).toEqual(buildTree(HERO_SOURCE, HERO_REL_PATH));
    expect(events).toHaveLength(0);
    expect(store.currentEvents()).toEqual([{ t: 'tree-snapshot', file: HERO_REL_PATH, tree }]);

    store.dispose();
  });

  it('scheduleRecompute debounces a burst of rapid calls into exactly one onRecomputed with the live tree', async () => {
    const abs = join(dir, 'Hero.tsx');
    await writeFile(abs, HERO_SOURCE);
    const events: TreeSnapshotEvent[] = [];
    const store = createTreeSnapshotStore({ onRecomputed: (e) => events.push(e), debounceMs: 30 });

    store.scheduleRecompute(abs, HERO_REL_PATH);
    store.scheduleRecompute(abs, HERO_REL_PATH);
    store.scheduleRecompute(abs, HERO_REL_PATH);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      t: 'tree-snapshot',
      file: HERO_REL_PATH,
      tree: buildTree(HERO_SOURCE, HERO_REL_PATH),
    });

    store.dispose();
  });

  it('scheduleRecompute against a since-deleted file evicts the cache entry and emits nothing', async () => {
    const abs = join(dir, 'Hero.tsx');
    await writeFile(abs, HERO_SOURCE);
    const events: TreeSnapshotEvent[] = [];
    const store = createTreeSnapshotStore({ onRecomputed: (e) => events.push(e), debounceMs: 20 });
    await store.computeAndCache(abs, HERO_REL_PATH);
    expect(store.currentEvents()).toHaveLength(1);

    await rm(abs);
    store.scheduleRecompute(abs, HERO_REL_PATH);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toHaveLength(0);
    expect(store.currentEvents()).toHaveLength(0);

    store.dispose();
  });

  it('dispose cancels pending debounce timers so a scheduled recompute never fires', async () => {
    const abs = join(dir, 'Hero.tsx');
    await writeFile(abs, HERO_SOURCE);
    const events: TreeSnapshotEvent[] = [];
    const store = createTreeSnapshotStore({ onRecomputed: (e) => events.push(e), debounceMs: 30 });

    store.scheduleRecompute(abs, HERO_REL_PATH);
    store.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toHaveLength(0);
  });
});
