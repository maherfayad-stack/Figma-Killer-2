import { describe, expect, it } from 'vitest';
import { BridgeToStudioMessageSchema, StudioToBridgeMessageSchema } from './protocol.js';

describe('bridge <-> studio protocol schemas (ADR-0016)', () => {
  it('accepts every valid studio->bridge message shape', () => {
    const messages = [
      { source: 'ccs-studio', type: 'hit-test', requestId: 'r1', x: 1, y: 2 },
      { source: 'ccs-studio', type: 'report-rects', requestId: 'r2', uids: ['a', 'b'] },
      { source: 'ccs-studio', type: 'subscribe-rects', uids: ['a'] },
      { source: 'ccs-studio', type: 'unsubscribe-rects' },
      { source: 'ccs-studio', type: 'set-hover', uid: 'a' },
      { source: 'ccs-studio', type: 'set-hover', uid: null },
      { source: 'ccs-studio', type: 'set-selection', uids: [] },
    ];
    for (const message of messages) {
      expect(StudioToBridgeMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects a wrong source tag or unknown type', () => {
    expect(
      StudioToBridgeMessageSchema.safeParse({
        source: 'ccs-bridge',
        type: 'hit-test',
        requestId: 'r1',
        x: 1,
        y: 2,
      }).success,
    ).toBe(false);

    expect(
      StudioToBridgeMessageSchema.safeParse({ source: 'ccs-studio', type: 'not-real' }).success,
    ).toBe(false);
  });

  it('accepts every valid bridge->studio message shape', () => {
    const messages = [
      { source: 'ccs-bridge', type: 'ready', frame: 'Hero' },
      {
        source: 'ccs-bridge',
        type: 'hit-test-result',
        requestId: 'r1',
        hit: null,
      },
      {
        source: 'ccs-bridge',
        type: 'hit-test-result',
        requestId: 'r1',
        hit: {
          uid: 'src/frames/Hero.tsx:d0',
          rect: { x: 0, y: 0, width: 10, height: 10 },
          dynamic: false,
          component: null,
          breadcrumb: [{ uid: 'src/frames/Hero.tsx:d0', name: 'div' }],
        },
      },
      { source: 'ccs-bridge', type: 'rects-result', requestId: 'r2', rects: { a: null } },
      { source: 'ccs-bridge', type: 'rects-update', rects: {} },
    ];
    for (const message of messages) {
      expect(BridgeToStudioMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects extra/unknown fields (strict object schemas)', () => {
    expect(
      StudioToBridgeMessageSchema.safeParse({
        source: 'ccs-studio',
        type: 'unsubscribe-rects',
        somethingElse: true,
      }).success,
    ).toBe(false);
  });
});
