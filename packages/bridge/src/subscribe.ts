import { reportRects } from './rects.js';
import type { Rect } from './protocol.js';

export interface RectsSubscriptionOptions {
  win?: Window;
  doc?: Document;
  onUpdate: (rects: Record<string, Rect | null>) => void;
}

export interface RectsSubscription {
  subscribe(uids: string[]): void;
  unsubscribe(): void;
  /** Test/debug hook: force an immediate (non-rAF-throttled) flush. */
  flushNow(): void;
  dispose(): void;
}

/**
 * `subscribe-rects` / `unsubscribe-rects` — playbook §4/P2 pitfall: "Scroll
 * inside frames changes rects — bridge must stream rect updates
 * (rAF-throttled) while selected." Streams `rects-update` on scroll,
 * resize, and DOM mutation (attribute/childList/subtree — covers layout
 * changes from HMR re-renders, className changes, etc.) while subscribed.
 *
 * Uses a single `requestAnimationFrame` in-flight guard rather than
 * `setTimeout` debouncing: any number of scroll/resize/mutation events
 * between two animation frames collapse into exactly one `rects-update`,
 * which is the throttle behavior ADR-0016 asks for ("rAF-throttled").
 */
export function createRectsSubscription(options: RectsSubscriptionOptions): RectsSubscription {
  const win = options.win ?? window;
  const doc = options.doc ?? document;

  let subscribedUids: string[] = [];
  let rafHandle: number | null = null;
  let mutationObserver: MutationObserver | null = null;

  function flush() {
    rafHandle = null;
    if (subscribedUids.length === 0) return;
    options.onUpdate(reportRects(subscribedUids, doc));
  }

  function schedule() {
    if (rafHandle !== null) return;
    rafHandle = win.requestAnimationFrame(flush);
  }

  function subscribe(uids: string[]) {
    subscribedUids = uids;

    if (!mutationObserver) {
      // `MutationObserver` is a global constructor (not a `Window` property
      // in TypeScript's DOM lib types, even though real browsers/jsdom do
      // expose `window.MutationObserver`) — use the global directly so this
      // typechecks regardless of the injected `win`.
      mutationObserver = new MutationObserver(schedule);
      mutationObserver.observe(doc.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      win.addEventListener('scroll', schedule, true);
      win.addEventListener('resize', schedule);
    }

    schedule();
  }

  function unsubscribe() {
    subscribedUids = [];
    if (rafHandle !== null) {
      win.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      win.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
    }
  }

  return {
    subscribe,
    unsubscribe,
    flushNow: flush,
    dispose: unsubscribe,
  };
}
