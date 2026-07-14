import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitUidRemap, onUidRemap, useSelectionStore } from './selection-store.js';

function resetStore(): void {
  useSelectionStore.setState({
    editModeFrame: null,
    previousCamera: null,
    hoveredUid: null,
    hover: null,
    selectedUids: [],
    selections: {},
    breadcrumb: [],
  });
}

beforeEach(() => {
  resetStore();
});

describe('enterEditMode / exitEditMode', () => {
  it('sets editModeFrame + previousCamera and clears any prior hover/selection', () => {
    useSelectionStore.getState().setHover({ uid: 'a', rect: { x: 0, y: 0, width: 1, height: 1 }, dynamic: false, component: null, name: 'a' });
    useSelectionStore
      .getState()
      .enterEditMode({ shapeId: 'shape:x', fileFolder: 'demo', framePath: 'src/frames/Hero.tsx' }, { x: 1, y: 2, z: 1 });

    const state = useSelectionStore.getState();
    expect(state.editModeFrame).toEqual({ shapeId: 'shape:x', fileFolder: 'demo', framePath: 'src/frames/Hero.tsx' });
    expect(state.previousCamera).toEqual({ x: 1, y: 2, z: 1 });
    expect(state.hover).toBeNull();
    expect(state.selectedUids).toEqual([]);
  });

  it('exitEditMode returns the frame + previousCamera that were active and clears state', () => {
    useSelectionStore
      .getState()
      .enterEditMode({ shapeId: 'shape:x', fileFolder: 'demo', framePath: 'src/frames/Hero.tsx' }, { x: 5, y: 6, z: 2 });

    const result = useSelectionStore.getState().exitEditMode();
    expect(result).toEqual({
      frame: { shapeId: 'shape:x', fileFolder: 'demo', framePath: 'src/frames/Hero.tsx' },
      previousCamera: { x: 5, y: 6, z: 2 },
    });
    expect(useSelectionStore.getState().editModeFrame).toBeNull();
  });

  it('exitEditMode is a no-op returning null when not in edit mode', () => {
    expect(useSelectionStore.getState().exitEditMode()).toBeNull();
  });
});

describe('setHover / setSelection', () => {
  it('setHover stores hoveredUid + the full hover record', () => {
    useSelectionStore.getState().setHover({ uid: 'a', rect: { x: 1, y: 2, width: 3, height: 4 }, dynamic: false, component: 'Button', name: 'Button' });
    const state = useSelectionStore.getState();
    expect(state.hoveredUid).toBe('a');
    expect(state.hover?.component).toBe('Button');
  });

  it('setHover(null) clears hover', () => {
    useSelectionStore.getState().setHover({ uid: 'a', rect: { x: 0, y: 0, width: 1, height: 1 }, dynamic: false, component: null, name: 'a' });
    useSelectionStore.getState().setHover(null);
    expect(useSelectionStore.getState().hoveredUid).toBeNull();
    expect(useSelectionStore.getState().hover).toBeNull();
  });

  it('setSelection populates selectedUids/selections/breadcrumb from a hit', () => {
    useSelectionStore.getState().setSelection({
      uid: 'src/frames/Hero.tsx:d0.1',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      dynamic: false,
      component: 'ds:Button',
      breadcrumb: [{ uid: 'src/frames/Hero.tsx:d0', name: 'Hero' }, { uid: 'src/frames/Hero.tsx:d0.1', name: 'Button' }],
    });
    const state = useSelectionStore.getState();
    expect(state.selectedUids).toEqual(['src/frames/Hero.tsx:d0.1']);
    expect(state.selections['src/frames/Hero.tsx:d0.1']).toMatchObject({ component: 'ds:Button', detached: false });
    expect(state.breadcrumb).toHaveLength(2);
  });

  it('setSelection(null) clears selection + breadcrumb', () => {
    useSelectionStore.getState().setSelection({ uid: 'a', rect: null, dynamic: false, component: null, breadcrumb: [] });
    useSelectionStore.getState().setSelection(null);
    const state = useSelectionStore.getState();
    expect(state.selectedUids).toEqual([]);
    expect(state.selections).toEqual({});
    expect(state.breadcrumb).toEqual([]);
  });
});

describe('updateSelectionRect / markSelectionDetached', () => {
  beforeEach(() => {
    useSelectionStore.getState().setSelection({ uid: 'a', rect: { x: 0, y: 0, width: 1, height: 1 }, dynamic: false, component: null, breadcrumb: [] });
  });

  it('updateSelectionRect updates the rect for a currently-selected uid', () => {
    useSelectionStore.getState().updateSelectionRect('a', { x: 9, y: 9, width: 2, height: 2 });
    expect(useSelectionStore.getState().selections['a']?.rect).toEqual({ x: 9, y: 9, width: 2, height: 2 });
  });

  it('updateSelectionRect is a no-op for a uid not currently selected (stale reply)', () => {
    const before = useSelectionStore.getState().selections;
    useSelectionStore.getState().updateSelectionRect('not-selected', { x: 0, y: 0, width: 1, height: 1 });
    expect(useSelectionStore.getState().selections).toBe(before);
  });

  it('markSelectionDetached flags the uid without removing it from selectedUids', () => {
    useSelectionStore.getState().markSelectionDetached('a');
    const state = useSelectionStore.getState();
    expect(state.selectedUids).toEqual(['a']);
    expect(state.selections['a']?.detached).toBe(true);
  });
});

describe('applyUidRemap (playbook §4/P2 pitfall / ADR-0016)', () => {
  it('remaps a selected uid found as a key in the map, keeping rect/breadcrumb/dynamic', () => {
    useSelectionStore.getState().setSelection({
      uid: 'src/frames/Hero.tsx:d0.1',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      dynamic: true,
      component: 'ds:Button',
      breadcrumb: [{ uid: 'src/frames/Hero.tsx:d0', name: 'Hero' }],
    });
    const remapped = useSelectionStore.getState().applyUidRemap({
      'src/frames/Hero.tsx:d0.1': 'src/frames/Hero.tsx:d0.2',
    });
    expect(remapped).toEqual(['src/frames/Hero.tsx:d0.2']);
    const state = useSelectionStore.getState();
    expect(state.selectedUids).toEqual(['src/frames/Hero.tsx:d0.2']);
    expect(state.selections['src/frames/Hero.tsx:d0.2']).toMatchObject({ dynamic: true, component: 'ds:Button', detached: false });
    expect(state.selections['src/frames/Hero.tsx:d0.1']).toBeUndefined();
  });

  it('leaves an unmapped (not a key in the map) selected uid unchanged ("keep")', () => {
    useSelectionStore.getState().setSelection({ uid: 'a', rect: { x: 0, y: 0, width: 1, height: 1 }, dynamic: false, component: null, breadcrumb: [] });
    const remapped = useSelectionStore.getState().applyUidRemap({ 'other-uid': 'other-uid-2' });
    expect(remapped).toEqual([]);
    expect(useSelectionStore.getState().selectedUids).toEqual(['a']);
  });

  it('also remaps hoveredUid independently of selection', () => {
    useSelectionStore.getState().setHover({ uid: 'h1', rect: { x: 0, y: 0, width: 1, height: 1 }, dynamic: false, component: null, name: 'h1' });
    useSelectionStore.getState().applyUidRemap({ h1: 'h2' });
    expect(useSelectionStore.getState().hoveredUid).toBe('h2');
  });

  it('does not crash and returns [] when there is no current selection', () => {
    expect(useSelectionStore.getState().applyUidRemap({ x: 'y' })).toEqual([]);
  });
});

describe('uid-remap event bus', () => {
  it('emitUidRemap notifies all onUidRemap subscribers with the event', () => {
    const listener = vi.fn();
    const unsubscribe = onUidRemap(listener);
    const event = { t: 'uid-remap' as const, file: 'src/frames/Hero.tsx', map: { a: 'b' } };
    emitUidRemap(event);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    emitUidRemap(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
