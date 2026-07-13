import { describe, expect, it } from 'vitest';
import { captureFrameScreenshot } from './screenshot-capture.js';

// Minimal fakes — we only need the `.contentDocument.body` shape this
// module reads; no real DOM/jsdom required (keeps the package's test
// suite dependency-free of a browser environment, per the pure-logic
// testing strategy used throughout packages/canvas).
function fakeIframe(body: object | null): HTMLIFrameElement {
  return { contentDocument: body ? { body } : null } as unknown as HTMLIFrameElement;
}

describe('captureFrameScreenshot', () => {
  it('captures the iframe body via the injected capture function', async () => {
    const body = {};
    const iframe = fakeIframe(body);
    const capture = async (node: HTMLElement) => {
      expect(node).toBe(body);
      return 'data:image/png;base64,AAA';
    };
    expect(await captureFrameScreenshot(iframe, capture)).toBe('data:image/png;base64,AAA');
  });

  it('returns null when the iframe has no contentDocument (not same-origin-loaded yet)', async () => {
    const iframe = fakeIframe(null);
    const capture = async () => 'should-not-be-called';
    expect(await captureFrameScreenshot(iframe, capture)).toBeNull();
  });

  it('returns null (never throws) when the capture function rejects', async () => {
    const iframe = fakeIframe({});
    const capture = async () => {
      throw new Error('canvas tainted');
    };
    await expect(captureFrameScreenshot(iframe, capture)).resolves.toBeNull();
  });
});
