import { performHitTest } from './hit-test.js';
import { reportRects } from './rects.js';
import { createRectsSubscription } from './subscribe.js';
import { setHover, setSelection } from './highlight.js';
import {
  StudioToBridgeMessageSchema,
  type BridgeToStudioMessage,
  type StudioToBridgeMessage,
} from './protocol.js';

export interface InstallBridgeOptions {
  /** Injectable for tests; defaults to the real global `window`. The
   * bridge listens on this window's `message` event and reads/writes this
   * window's `document`/`parent`. */
  win?: Window;
}

export interface BridgeHandle {
  /** Removes all listeners/observers. */
  dispose(): void;
  /** Test/debug escape hatch: handle a message as if it had passed origin
   * validation, without going through `postMessage` at all. */
  handleMessageForTest(message: StudioToBridgeMessage): void;
}

function send(win: Window, message: BridgeToStudioMessage): void {
  // Target origin '*': the bridge runs inside a localhost dev-server iframe
  // (playbook §5.8 — daemon binds localhost only) and doesn't necessarily
  // know the studio's exact origin/port in advance; security here is
  // enforced by payload + `event.source` validation on both ends, not by
  // postMessage's targetOrigin.
  win.parent.postMessage(message, '*');
}

function getFrameName(win: Window): string {
  return new URLSearchParams(win.location.search).get('frame') ?? '';
}

/**
 * Installs the bridge (playbook §4/P2, ADR-0016): listens for
 * `ccs-studio`-sourced postMessages from `window.parent`, replies to
 * `hit-test`/`report-rects`, streams `rects-update` while subscribed,
 * applies `set-hover`/`set-selection` highlight classes, and sends the
 * `ready` handshake once the DOM is ready.
 *
 * Origin validation (mandatory, §5.8) is two-layered, matching ADR-0016's
 * exact wording ("bridge accepts only messages with source==='ccs-studio'
 * from window.parent"):
 *  1. `event.source === win.parent` — the REAL browser-level identity of
 *     the sending window. Spoofing this requires actually BEING that
 *     window object, which a hostile same-origin script inside the iframe
 *     cannot fake (unlike a data field).
 *  2. `event.data.source === 'ccs-studio'` (enforced by
 *     `StudioToBridgeMessageSchema`, a zod discriminated union) — the
 *     payload's declared tag + full shape validation.
 * Both must pass; either alone is insufficient.
 */
export function installBridge(options: InstallBridgeOptions = {}): BridgeHandle {
  const win = options.win ?? window;

  const rectsSubscription = createRectsSubscription({
    win,
    doc: win.document,
    onUpdate: (rects) => {
      send(win, { source: 'ccs-bridge', type: 'rects-update', rects });
    },
  });

  function handleStudioMessage(message: StudioToBridgeMessage): void {
    switch (message.type) {
      case 'hit-test': {
        const hit = performHitTest(message.x, message.y, win.document);
        send(win, {
          source: 'ccs-bridge',
          type: 'hit-test-result',
          requestId: message.requestId,
          hit,
        });
        return;
      }
      case 'report-rects': {
        send(win, {
          source: 'ccs-bridge',
          type: 'rects-result',
          requestId: message.requestId,
          rects: reportRects(message.uids, win.document),
        });
        return;
      }
      case 'subscribe-rects': {
        rectsSubscription.subscribe(message.uids);
        return;
      }
      case 'unsubscribe-rects': {
        rectsSubscription.unsubscribe();
        return;
      }
      case 'set-hover': {
        setHover(message.uid, win.document);
        return;
      }
      case 'set-selection': {
        setSelection(message.uids, win.document);
        return;
      }
    }
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== win.parent) return;
    const parsed = StudioToBridgeMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    handleStudioMessage(parsed.data);
  }

  win.addEventListener('message', onMessage);

  const sendReady = () =>
    send(win, { source: 'ccs-bridge', type: 'ready', frame: getFrameName(win) });
  if (win.document.readyState === 'complete' || win.document.readyState === 'interactive') {
    sendReady();
  } else {
    win.document.addEventListener('DOMContentLoaded', sendReady, { once: true });
  }

  return {
    dispose() {
      win.removeEventListener('message', onMessage);
      rectsSubscription.dispose();
    },
    handleMessageForTest: handleStudioMessage,
  };
}
