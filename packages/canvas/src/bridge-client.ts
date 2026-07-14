import {
  BridgeToStudioMessageSchema,
  type HitInfo,
  type Rect,
  type StudioToBridgeMessage,
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
  /** Injectable for tests; defaults to the real global `window`. Only
   * `addEventListener`/`removeEventListener` are used. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface BridgeConnection {
  hitTest(x: number, y: number): Promise<HitInfo | null>;
  reportRects(uids: string[]): Promise<Record<string, Rect | null>>;
  subscribeRects(uids: string[]): void;
  unsubscribeRects(): void;
  setHover(uid: string | null): void;
  setSelection(uids: string[]): void;
  dispose(): void;
}

let requestCounter = 0;
function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

export function connectBridge(options: BridgeConnectionOptions): BridgeConnection {
  const { iframeWindow, onRectsUpdate, onReady } = options;
  const win = options.win ?? window;

  const pendingHitTest = new Map<string, (hit: HitInfo | null) => void>();
  const pendingReportRects = new Map<string, (rects: Record<string, Rect | null>) => void>();

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
    dispose() {
      win.removeEventListener('message', onMessage as EventListener);
      pendingHitTest.clear();
      pendingReportRects.clear();
    },
  };
}
