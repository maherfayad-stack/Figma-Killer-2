// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBridge, type BridgeHandle } from './bridge.js';

/**
 * Acceptance test #2 (task brief): "load an HTML doc containing
 * data-uid-tagged elements + the bridge; simulate a hit-test postMessage
 * -> assert the reply's uid is the nearest tagged ancestor and breadcrumb
 * is correct; report-rects returns rects for requested uids; origin
 * validation rejects a spoofed source."
 *
 * jsdom doesn't implement real layout, so `document.elementFromPoint` is
 * stubbed per-test (standard practice for hit-test-style DOM tests under
 * jsdom) rather than relying on real paint geometry.
 */

const OUTER_UID = 'src/frames/Hero.tsx:d0';
const CARD_UID = 'src/frames/Hero.tsx:d0.0';
const BUTTON_UID = 'src/frames/Hero.tsx:d0.0.0';

function buildFixtureDom(): { icon: HTMLElement } {
  document.body.innerHTML = `
    <div data-uid="${OUTER_UID}">
      <section data-uid="${CARD_UID}" data-component="ds:Card">
        <button data-uid="${BUTTON_UID}" data-component="ds:Button">
          <span id="icon">*</span>
        </button>
      </section>
    </div>
  `;
  const icon = document.getElementById('icon');
  if (!icon) throw new Error('fixture setup failed');
  return { icon };
}

describe('bridge — hit-test / report-rects / origin validation', () => {
  let handle: BridgeHandle | undefined;
  let fakeParent: Window;
  let originalParent: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    fakeParent = { postMessage: vi.fn() } as unknown as Window;
    originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true });
  });

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    if (originalParent) Object.defineProperty(window, 'parent', originalParent);
  });

  it('replies to hit-test with the nearest data-uid ancestor and a correct outermost->innermost breadcrumb', () => {
    const { icon } = buildFixtureDom();
    // jsdom doesn't implement elementFromPoint at all (no real layout
    // engine) — assign it directly rather than vi.spyOn, which requires the
    // property to already exist on the object.
    document.elementFromPoint = () => icon;

    handle = installBridge();
    // The bridge sends an unsolicited `ready` handshake as soon as it's
    // installed (DOM already "complete" in jsdom) — clear that call so the
    // assertions below only see the message this test actually cares about.
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'ccs-studio', type: 'hit-test', requestId: 'req-1', x: 10, y: 20 },
        source: fakeParent,
      }),
    );

    expect(fakeParent.postMessage).toHaveBeenCalledTimes(1);
    const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toMatchObject({
      source: 'ccs-bridge',
      type: 'hit-test-result',
      requestId: 'req-1',
      hit: {
        uid: BUTTON_UID,
        dynamic: false,
        component: 'ds:Button',
      },
    });
    expect(message.hit.breadcrumb).toEqual([
      { uid: OUTER_UID, name: 'div' },
      { uid: CARD_UID, name: 'ds:Card' },
      { uid: BUTTON_UID, name: 'ds:Button' },
    ]);
  });

  it('replies with hit: null when elementFromPoint misses everything tagged', () => {
    document.body.innerHTML = `<div id="untagged">no uid here</div>`;
    const untagged = document.getElementById('untagged')!;
    document.elementFromPoint = () => untagged;

    handle = installBridge();
    // The bridge sends an unsolicited `ready` handshake as soon as it's
    // installed (DOM already "complete" in jsdom) — clear that call so the
    // assertions below only see the message this test actually cares about.
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'ccs-studio', type: 'hit-test', requestId: 'req-2', x: 0, y: 0 },
        source: fakeParent,
      }),
    );

    const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toMatchObject({ type: 'hit-test-result', requestId: 'req-2', hit: null });
  });

  it('report-rects returns a rect per requested uid and null for unknown uids', () => {
    buildFixtureDom();
    handle = installBridge();
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: 'ccs-studio',
          type: 'report-rects',
          requestId: 'req-3',
          uids: [OUTER_UID, BUTTON_UID, 'src/frames/Hero.tsx:d99'],
        },
        source: fakeParent,
      }),
    );

    const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message.type).toBe('rects-result');
    expect(message.requestId).toBe('req-3');
    expect(Object.keys(message.rects).sort()).toEqual(
      [OUTER_UID, BUTTON_UID, 'src/frames/Hero.tsx:d99'].sort(),
    );
    expect(message.rects[OUTER_UID]).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
    expect(message.rects['src/frames/Hero.tsx:d99']).toBeNull();
  });

  it('rejects a message whose event.source is not window.parent, even with a correct payload source tag', () => {
    buildFixtureDom();
    handle = installBridge();
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

    const impostor = { postMessage: vi.fn() } as unknown as Window;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'ccs-studio', type: 'report-rects', requestId: 'req-4', uids: [OUTER_UID] },
        source: impostor, // NOT window.parent
      }),
    );

    expect(fakeParent.postMessage).not.toHaveBeenCalled();
  });

  it('rejects a message from window.parent whose payload source tag is spoofed/wrong', () => {
    buildFixtureDom();
    handle = installBridge();
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'evil-spoof', type: 'report-rects', requestId: 'req-5', uids: [OUTER_UID] },
        source: fakeParent,
      }),
    );

    expect(fakeParent.postMessage).not.toHaveBeenCalled();
  });

  it('rejects a structurally invalid message (fails zod validation) even from the right window+source', () => {
    buildFixtureDom();
    handle = installBridge();
    (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'ccs-studio', type: 'not-a-real-type' },
        source: fakeParent,
      }),
    );

    expect(fakeParent.postMessage).not.toHaveBeenCalled();
  });

  describe('FP-4a — enter-text-edit', () => {
    it('replies text-edit-entered for a plain text-leaf node, then text-edit-exit on Enter', () => {
      document.body.innerHTML = `<p data-uid="${BUTTON_UID}">Click me</p>`;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'enter-text-edit', requestId: 'te-1', uid: BUTTON_UID },
          source: fakeParent,
        }),
      );

      const [entered] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(entered).toEqual({
        source: 'ccs-bridge',
        type: 'text-edit-entered',
        requestId: 'te-1',
        uid: BUTTON_UID,
        text: 'Click me',
      });

      const el = document.querySelector(`[data-uid="${BUTTON_UID}"]`) as HTMLElement;
      el.textContent = 'Clicked!';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

      const [exit] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[1]!;
      expect(exit).toEqual({
        source: 'ccs-bridge',
        type: 'text-edit-exit',
        uid: BUTTON_UID,
        committed: true,
        text: 'Clicked!',
      });
    });

    it('replies text-edit-rejected for a dynamic-locked node — no contenteditable applied', () => {
      document.body.innerHTML = `<p data-uid="${BUTTON_UID}" data-dynamic="true">Item</p>`;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'enter-text-edit', requestId: 'te-2', uid: BUTTON_UID },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message).toEqual({
        source: 'ccs-bridge',
        type: 'text-edit-rejected',
        requestId: 'te-2',
        uid: BUTTON_UID,
        reason: 'dynamic-locked',
      });
      const el = document.querySelector(`[data-uid="${BUTTON_UID}"]`) as HTMLElement;
      expect(el.getAttribute('contenteditable')).toBeNull();
    });
  });

  describe('FP-4b — report-parent-layout / resolve-free-drop (D-EDIT context-aware drag)', () => {
    it('report-parent-layout: flex parent -> mode "flex", correct axis + sibling order', () => {
      document.body.innerHTML = `
        <section data-uid="parent" style="display:flex;flex-direction:row">
          <h1 data-uid="a">A</h1>
          <p data-uid="b">B</p>
        </section>
      `;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'report-parent-layout', requestId: 'pl-1', uid: 'b' },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message).toEqual({
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: 'pl-1',
        uid: 'b',
        result: {
          ok: true,
          info: {
            mode: 'flex',
            axis: 'row',
            parentUid: 'parent',
            parentPositioned: false,
            parentRect: expect.objectContaining({ x: expect.any(Number) }),
            index: 1,
            siblingUids: ['a', 'b'],
          },
        },
      });
    });

    it('report-parent-layout: plain (non-flex/grid) parent -> mode "none" (FREE-DRAG branch)', () => {
      document.body.innerHTML = `<div data-uid="parent"><span data-uid="a">A</span></div>`;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'report-parent-layout', requestId: 'pl-2', uid: 'a' },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message.result.ok).toBe(true);
      expect(message.result.info.mode).toBe('none');
    });

    it('report-parent-layout: rejects a dynamic-locked node (defense in depth)', () => {
      document.body.innerHTML = `<div style="display:flex"><span data-uid="a" data-dynamic="true">A</span></div>`;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'report-parent-layout', requestId: 'pl-3', uid: 'a' },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message).toEqual({
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: 'pl-3',
        uid: 'a',
        result: { ok: false, reason: 'dynamic-locked' },
      });
    });

    it('resolve-free-drop: resolves absolute + start/top classes for the dragged node', () => {
      document.body.innerHTML = `<div data-uid="parent"><span data-uid="a">A</span></div>`;
      const parent = document.querySelector('[data-uid="parent"]') as HTMLElement;
      const el = document.querySelector('[data-uid="a"]') as HTMLElement;
      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, toJSON: () => ({}),
      } as DOMRect);
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20, toJSON: () => ({}),
      } as DOMRect);

      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'resolve-free-drop', requestId: 'fd-1', uid: 'a', targetX: 50, targetY: 30 },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message).toEqual({
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: 'fd-1',
        uid: 'a',
        result: {
          ok: true,
          info: {
            addClasses: ['absolute', 'start-[50px]', 'top-[30px]'],
            removeClasses: [],
            parentUid: 'parent',
            parentAddClasses: ['relative'],
          },
        },
      });
    });

    it('resolve-free-drop: rejects a dynamic-locked node', () => {
      document.body.innerHTML = `<div><span data-uid="a" data-dynamic="true">A</span></div>`;
      handle = installBridge();
      (fakeParent.postMessage as ReturnType<typeof vi.fn>).mockClear();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ccs-studio', type: 'resolve-free-drop', requestId: 'fd-2', uid: 'a', targetX: 0, targetY: 0 },
          source: fakeParent,
        }),
      );

      const [message] = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(message).toEqual({
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: 'fd-2',
        uid: 'a',
        result: { ok: false, reason: 'dynamic-locked' },
      });
    });
  });
});
