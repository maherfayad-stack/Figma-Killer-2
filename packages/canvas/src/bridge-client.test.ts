import { describe, expect, it, vi } from 'vitest';
import { connectBridge } from './bridge-client.js';

/**
 * Fake `window`-shaped test double (no jsdom — same "pure fakes, no real
 * DOM" discipline as `screenshot-capture.test.ts`/`daemon-client.test.ts`
 * elsewhere in this package). `FakeWindow` doubles as BOTH the injected
 * `win` (the studio's own window, whose `addEventListener` the connection
 * subscribes to) and the `iframeWindow` sentinel (`postMessage` target +
 * the `event.source` identity `onMessage` checks) — a real browser has two
 * distinct `Window` objects, but the connection only ever compares them by
 * reference, so one fake standing in for the iframe's `contentWindow`
 * (`postMessage` recorded here) is enough to drive the whole exchange.
 */
class FakeWindow {
  listeners = new Set<(event: MessageEvent) => void>();
  posted: unknown[] = [];

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(listener as (event: MessageEvent) => void);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.delete(listener as (event: MessageEvent) => void);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  /** Simulates the iframe's bridge replying — `source` is THIS fake acting
   * as the iframe window (matches `event.source === iframeWindow`). */
  emitFromBridge(data: unknown): void {
    const event = { source: this, data } as unknown as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }
}

function setup() {
  const iframeWindow = new FakeWindow();
  const onRectsUpdate = vi.fn();
  const onReady = vi.fn();
  const connection = connectBridge({
    iframeWindow: iframeWindow as unknown as Window,
    onRectsUpdate,
    onReady,
    win: iframeWindow,
  });
  return { iframeWindow, onRectsUpdate, onReady, connection };
}

describe('connectBridge', () => {
  it('hitTest sends a ccs-studio hit-test request and resolves from the matching hit-test-result', async () => {
    const { iframeWindow, connection } = setup();
    const promise = connection.hitTest(12, 34);
    expect(iframeWindow.posted).toHaveLength(1);
    const sent = iframeWindow.posted[0] as { type: string; requestId: string; x: number; y: number };
    expect(sent).toMatchObject({ source: 'ccs-studio', type: 'hit-test', x: 12, y: 34 });

    const hit = { uid: 'src/frames/Hero.tsx:d0', rect: { x: 0, y: 0, width: 10, height: 10 }, dynamic: false, component: null, breadcrumb: [] };
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'hit-test-result', requestId: sent.requestId, hit });
    await expect(promise).resolves.toEqual(hit);
  });

  it('hitTest resolves null when the bridge reports no hit', async () => {
    const { iframeWindow, connection } = setup();
    const promise = connection.hitTest(0, 0);
    const sent = iframeWindow.posted[0] as { requestId: string };
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'hit-test-result', requestId: sent.requestId, hit: null });
    await expect(promise).resolves.toBeNull();
  });

  it('reportRects resolves from the matching rects-result', async () => {
    const { iframeWindow, connection } = setup();
    const promise = connection.reportRects(['a', 'b']);
    const sent = iframeWindow.posted[0] as { requestId: string; uids: string[] };
    expect(sent.uids).toEqual(['a', 'b']);
    const rects = { a: { x: 1, y: 2, width: 3, height: 4 }, b: null };
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'rects-result', requestId: sent.requestId, rects });
    await expect(promise).resolves.toEqual(rects);
  });

  it('ignores a hit-test-result with a stale/unmatched requestId (no throw, promise stays pending)', async () => {
    const { iframeWindow, connection } = setup();
    let resolved = false;
    void connection.hitTest(1, 1).then(() => {
      resolved = true;
    });
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'hit-test-result', requestId: 'not-the-real-one', hit: null });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('routes unsolicited rects-update to onRectsUpdate', () => {
    const { iframeWindow, onRectsUpdate } = setup();
    const rects = { a: { x: 0, y: 0, width: 1, height: 1 } };
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'rects-update', rects });
    expect(onRectsUpdate).toHaveBeenCalledWith(rects);
  });

  it('routes the ready handshake to onReady with the frame name', () => {
    const { iframeWindow, onReady } = setup();
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'ready', frame: 'Hero' });
    expect(onReady).toHaveBeenCalledWith('Hero');
  });

  it('subscribeRects / unsubscribeRects / setHover / setSelection send the expected ccs-studio envelopes', () => {
    const { iframeWindow, connection } = setup();
    connection.subscribeRects(['a', 'b']);
    connection.unsubscribeRects();
    connection.setHover('x');
    connection.setHover(null);
    connection.setSelection(['x', 'y']);
    expect(iframeWindow.posted).toEqual([
      { source: 'ccs-studio', type: 'subscribe-rects', uids: ['a', 'b'] },
      { source: 'ccs-studio', type: 'unsubscribe-rects' },
      { source: 'ccs-studio', type: 'set-hover', uid: 'x' },
      { source: 'ccs-studio', type: 'set-hover', uid: null },
      { source: 'ccs-studio', type: 'set-selection', uids: ['x', 'y'] },
    ]);
  });

  it('rejects a message whose event.source is not the connected iframeWindow (origin validation)', () => {
    const { iframeWindow, onRectsUpdate } = setup();
    const impostor = new FakeWindow();
    const event = { source: impostor, data: { source: 'ccs-bridge', type: 'rects-update', rects: {} } } as unknown as MessageEvent;
    for (const listener of iframeWindow.listeners) listener(event);
    expect(onRectsUpdate).not.toHaveBeenCalled();
  });

  it('rejects a payload not tagged source: ccs-bridge even from the right window', () => {
    const { iframeWindow, onRectsUpdate } = setup();
    iframeWindow.emitFromBridge({ source: 'ccs-studio', type: 'rects-update', rects: {} });
    expect(onRectsUpdate).not.toHaveBeenCalled();
  });

  it('dispose stops routing further messages', () => {
    const { iframeWindow, onReady, connection } = setup();
    connection.dispose();
    iframeWindow.emitFromBridge({ source: 'ccs-bridge', type: 'ready', frame: 'Hero' });
    expect(onReady).not.toHaveBeenCalled();
  });

  describe('FP-4a — enterTextEdit / onTextEditExit', () => {
    it('enterTextEdit sends a ccs-studio enter-text-edit request and resolves ok on text-edit-entered', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.enterTextEdit('a');
      const sent = iframeWindow.posted[0] as { type: string; requestId: string; uid: string };
      expect(sent).toMatchObject({ source: 'ccs-studio', type: 'enter-text-edit', uid: 'a' });

      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'text-edit-entered',
        requestId: sent.requestId,
        uid: 'a',
        text: 'Hello',
      });
      await expect(promise).resolves.toEqual({ ok: true, text: 'Hello' });
    });

    it('enterTextEdit resolves not-ok with the reason on text-edit-rejected', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.enterTextEdit('a');
      const sent = iframeWindow.posted[0] as { requestId: string };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'text-edit-rejected',
        requestId: sent.requestId,
        uid: 'a',
        reason: 'dynamic-locked',
      });
      await expect(promise).resolves.toEqual({ ok: false, reason: 'dynamic-locked' });
    });

    it('routes an unsolicited text-edit-exit to onTextEditExit', () => {
      const iframeWindow = new FakeWindow();
      const onTextEditExit = vi.fn();
      connectBridge({
        iframeWindow: iframeWindow as unknown as Window,
        onRectsUpdate: vi.fn(),
        onTextEditExit,
        win: iframeWindow,
      });
      const exit = { source: 'ccs-bridge', type: 'text-edit-exit', uid: 'a', committed: true, text: 'done' };
      iframeWindow.emitFromBridge(exit);
      expect(onTextEditExit).toHaveBeenCalledWith(exit);
    });
  });

  describe('FP-4b — reportParentLayout / resolveFreeDrop', () => {
    it('reportParentLayout sends a ccs-studio report-parent-layout request and resolves from the matching reply', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.reportParentLayout('a');
      const sent = iframeWindow.posted[0] as { type: string; requestId: string; uid: string };
      expect(sent).toMatchObject({ source: 'ccs-studio', type: 'report-parent-layout', uid: 'a' });

      const info = {
        mode: 'flex' as const,
        axis: 'row' as const,
        parentUid: 'p',
        parentPositioned: false,
        parentRect: { x: 0, y: 0, width: 10, height: 10 },
        index: 0,
        siblingUids: ['a', 'b'],
      };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: true, info },
      });
      await expect(promise).resolves.toEqual({ ok: true, info });
    });

    it('reportParentLayout resolves not-ok with the reason', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.reportParentLayout('a');
      const sent = iframeWindow.posted[0] as { requestId: string };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: false, reason: 'dynamic-locked' },
      });
      await expect(promise).resolves.toEqual({ ok: false, reason: 'dynamic-locked' });
    });

    it('resolveFreeDrop sends a ccs-studio resolve-free-drop request with targetX/targetY and resolves from the matching reply', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.resolveFreeDrop('a', 100, 200);
      const sent = iframeWindow.posted[0] as { type: string; requestId: string; uid: string; targetX: number; targetY: number };
      expect(sent).toMatchObject({ source: 'ccs-studio', type: 'resolve-free-drop', uid: 'a', targetX: 100, targetY: 200 });

      const info = { addClasses: ['absolute', 'start-[100px]', 'top-[200px]'], removeClasses: [], parentUid: 'p', parentAddClasses: ['relative'] };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: true, info },
      });
      await expect(promise).resolves.toEqual({ ok: true, info });
    });

    it('resolveFreeDrop resolves not-ok with the reason', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.resolveFreeDrop('a', 0, 0);
      const sent = iframeWindow.posted[0] as { requestId: string };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: false, reason: 'not-found' },
      });
      await expect(promise).resolves.toEqual({ ok: false, reason: 'not-found' });
    });
  });

  describe('FP-INS-b — requestComputedStyle', () => {
    it('sends a ccs-studio report-computed-style request and resolves from the matching reply', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.requestComputedStyle('a');
      const sent = iframeWindow.posted[0] as { type: string; requestId: string; uid: string };
      expect(sent).toMatchObject({ source: 'ccs-studio', type: 'report-computed-style', uid: 'a' });

      const info = { rows: [{ group: 'typography' as const, prop: 'font-size', value: '32px' }] };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'computed-style-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: true, info },
      });
      await expect(promise).resolves.toEqual({ ok: true, info });
    });

    it('resolves not-ok with the reason', async () => {
      const { iframeWindow, connection } = setup();
      const promise = connection.requestComputedStyle('a');
      const sent = iframeWindow.posted[0] as { requestId: string };
      iframeWindow.emitFromBridge({
        source: 'ccs-bridge',
        type: 'computed-style-result',
        requestId: sent.requestId,
        uid: 'a',
        result: { ok: false, reason: 'not-found' },
      });
      await expect(promise).resolves.toEqual({ ok: false, reason: 'not-found' });
    });
  });
});
