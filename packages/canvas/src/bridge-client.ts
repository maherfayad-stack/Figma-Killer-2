import {
  BridgeToStudioMessageSchema,
  type HitInfo,
  type Rect,
  type StudioToBridgeMessage,
  type TextEditExit,
} from '@ccs/bridge';

/**
 * Studio-side counterpart of `@ccs/bridge`'s `installBridge` (playbook
 * §4/P2, ADR-0016 — FROZEN postMessage contract). One `connectBridge` call
 * wraps ONE edit-mode frame's iframe: `edit-mode-layer.tsx` opens a
 * connection when a frame enters edit mode and disposes it on exit/frame
 * switch (only one frame is ever in edit mode at a time — playbook §4/P2).
 *
 * Origin validation mirrors `bridge.ts`'s (§5.8, two-layered):
 *  1. `event.source === iframeWindow` — the iframe's real `Window` identity
 *     (a hostile script anywhere else cannot forge this).
 *  2. `event.data.source === 'ccs-bridge'`, enforced by
 *     `BridgeToStudioMessageSchema` (a zod discriminated union) — the full
 *     payload shape, not just the tag.
 * Both must pass.
 */

export interface BridgeConnectionOptions {
  /** The edit-mode frame's iframe `Window` (`iframe.contentWindow`) — the
   * ONLY window this connection ever sends to/accepts messages from. */
  iframeWindow: Window;
  /** Unsolicited `rects-update` stream while a `subscribe-rects` is active. */
  onRectsUpdate: (rects: Record<string, Rect | null>) => void;
  /** Bridge (re)installed handshake — fires once on initial load, and again
   * any time the iframe's document reloads (e.g. a non-HMR-able edit
   * triggers a full Vite reload), which callers use to re-issue
   * `subscribe-rects` for whatever's currently selected (playbook §4/P2
   * pitfall: rect subscriptions don't survive a hard iframe reload). */
  onReady?: (frame: string) => void;
  /** FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4): fires whenever
   * an in-progress in-place text edit ends inside this connection's iframe
   * — however it ended (Enter/blur commit, or Esc cancel). Unsolicited,
   * exactly mirroring the bridge's own `text-edit-exit` message (see
   * `@ccs/bridge`'s `protocol.ts`/`text-edit.ts`). */
  onTextEditExit?: (exit: TextEditExit) => void;
  /** Injectable for tests; defaults to the real global `window`. Only
   * `addEventListener`/`removeEventListener` are used. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** FP-4a: `enterTextEdit`'s resolved outcome — mirrors the bridge's
 * `text-edit-entered`/`text-edit-rejected` reply pair as a single
 * discriminated result rather than two separate promise shapes. */
export type EnterTextEditResult = { ok: true; text: string } | { ok: false; reason: string };

export interface BridgeConnection {
  hitTest(x: number, y: number): Promise<HitInfo | null>;
  reportRects(uids: string[]): Promise<Record<string, Rect | null>>;
  subscribeRects(uids: string[]): void;
  unsubscribeRects(): void;
  setHover(uid: string | null): void;
  setSelection(uids: string[]): void;
  /** FP-4a: requests the bridge turn `uid`'s node `contentEditable` inside
   * the iframe. Resolves once the bridge replies `text-edit-entered` (ok)
   * or `text-edit-rejected` (not editable — dynamic-locked, a component
   * usage site, not a text leaf, etc.). Ending the edit is NOT driven from
   * here — see `onTextEditExit`. */
  enterTextEdit(uid: string): Promise<EnterTextEditResult>;
  dispose(): void;
}

let requestCounter = 0;
function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

export function connectBridge(options: BridgeConnectionOptions): BridgeConnection {
  const { iframeWindow, onRectsUpdate, onReady, onTextEditExit } = options;
  const win = options.win ?? window;

  const pendingHitTest = new Map<string, (hit: HitInfo | null) => void>();
  const pendingReportRects = new Map<string, (rects: Record<string, Rect | null>) => void>();
  const pendingTextEdit = new Map<string, (result: EnterTextEditResult) => void>();

  function send(message: StudioToBridgeMessage): void {
    // Target origin '*' mirrors `bridge.ts`'s own `send()` — the studio
    // doesn't necessarily know the file-app dev server's exact origin in
    // advance either (daemon-allocated port); security is enforced by the
    // `event.source`/payload checks in `onMessage` below, not targetOrigin.
    iframeWindow.postMessage(message, '*');
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== iframeWindow) return;
    const parsed = BridgeToStudioMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'hit-test-result': {
        const resolve = pendingHitTest.get(message.requestId);
        if (!resolve) return; // stale/unmatched reply — ignore
        pendingHitTest.delete(message.requestId);
        resolve(message.hit);
        return;
      }
      case 'rects-result': {
        const resolve = pendingReportRects.get(message.requestId);
        if (!resolve) return;
        pendingReportRects.delete(message.requestId);
        resolve(message.rects);
        return;
      }
      case 'rects-update':
        onRectsUpdate(message.rects);
        return;
      case 'ready':
        onReady?.(message.frame);
        return;
      case 'text-edit-entered': {
        const resolve = pendingTextEdit.get(message.requestId);
        if (!resolve) return;
        pendingTextEdit.delete(message.requestId);
        resolve({ ok: true, text: message.text });
        return;
      }
      case 'text-edit-rejected': {
        const resolve = pendingTextEdit.get(message.requestId);
        if (!resolve) return;
        pendingTextEdit.delete(message.requestId);
        resolve({ ok: false, reason: message.reason });
        return;
      }
      case 'text-edit-exit':
        onTextEditExit?.(message);
        return;
    }
  }

  win.addEventListener('message', onMessage as EventListener);

  return {
    hitTest(x, y) {
      const requestId = nextRequestId('hit-test');
      return new Promise((resolve) => {
        pendingHitTest.set(requestId, resolve);
        send({ source: 'ccs-studio', type: 'hit-test', requestId, x, y });
      });
    },
    reportRects(uids) {
      const requestId = nextRequestId('report-rects');
      return new Promise((resolve) => {
        pendingReportRects.set(requestId, resolve);
        send({ source: 'ccs-studio', type: 'report-rects', requestId, uids });
      });
    },
    subscribeRects(uids) {
      send({ source: 'ccs-studio', type: 'subscribe-rects', uids });
    },
    unsubscribeRects() {
      send({ source: 'ccs-studio', type: 'unsubscribe-rects' });
    },
    setHover(uid) {
      send({ source: 'ccs-studio', type: 'set-hover', uid });
    },
    setSelection(uids) {
      send({ source: 'ccs-studio', type: 'set-selection', uids });
    },
    enterTextEdit(uid) {
      const requestId = nextRequestId('enter-text-edit');
      return new Promise((resolve) => {
        pendingTextEdit.set(requestId, resolve);
        send({ source: 'ccs-studio', type: 'enter-text-edit', requestId, uid });
      });
    },
    dispose() {
      win.removeEventListener('message', onMessage as EventListener);
      pendingHitTest.clear();
      pendingReportRects.clear();
      pendingTextEdit.clear();
    },
  };
}
