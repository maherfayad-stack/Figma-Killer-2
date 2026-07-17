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
      { source: 'ccs-studio', type: 'enter-text-edit', requestId: 'r3', uid: 'src/frames/Hero.tsx:d0' },
      { source: 'ccs-studio', type: 'report-parent-layout', requestId: 'r4', uid: 'a' },
      { source: 'ccs-studio', type: 'resolve-free-drop', requestId: 'r5', uid: 'a', targetX: 10, targetY: 20 },
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
      { source: 'ccs-bridge', type: 'text-edit-entered', requestId: 'r3', uid: 'a', text: 'Hello' },
      { source: 'ccs-bridge', type: 'text-edit-rejected', requestId: 'r3', uid: 'a', reason: 'dynamic-locked' },
      { source: 'ccs-bridge', type: 'text-edit-exit', uid: 'a', committed: true, text: 'Hello world' },
      { source: 'ccs-bridge', type: 'text-edit-exit', uid: 'a', committed: false, text: null },
      {
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: 'r4',
        uid: 'a',
        result: {
          ok: true,
          info: {
            mode: 'flex',
            axis: 'row',
            parentUid: 'p',
            parentPositioned: false,
            parentRect: { x: 0, y: 0, width: 10, height: 10 },
            index: 0,
            siblingUids: ['a', 'b'],
          },
        },
      },
      {
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: 'r4',
        uid: 'a',
        result: { ok: false, reason: 'dynamic-locked' },
      },
      {
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: 'r5',
        uid: 'a',
        result: {
          ok: true,
          info: { addClasses: ['absolute'], removeClasses: [], parentUid: 'p', parentAddClasses: ['relative'] },
        },
      },
      {
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: 'r5',
        uid: 'a',
        result: { ok: false, reason: 'not-found' },
      },
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

  it('FP-4b: rejects report-parent-layout/resolve-free-drop missing required fields or with extras', () => {
    expect(
      StudioToBridgeMessageSchema.safeParse({ source: 'ccs-studio', type: 'report-parent-layout', requestId: 'r1' })
        .success,
    ).toBe(false); // missing uid
    expect(
      StudioToBridgeMessageSchema.safeParse({
        source: 'ccs-studio',
        type: 'resolve-free-drop',
        requestId: 'r1',
        uid: 'a',
        targetX: 1,
        targetY: 2,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      BridgeToStudioMessageSchema.safeParse({
        source: 'ccs-bridge',
        type: 'parent-layout-result',
        requestId: 'r1',
        uid: 'a',
        result: { ok: true }, // missing info
      }).success,
    ).toBe(false);
    expect(
      BridgeToStudioMessageSchema.safeParse({
        source: 'ccs-bridge',
        type: 'free-drop-result',
        requestId: 'r1',
        uid: 'a',
        result: { ok: false, reason: 'not-a-real-reason' },
      }).success,
    ).toBe(false);
  });

  it('FP-4a: rejects enter-text-edit / text-edit-exit missing required fields or with extras', () => {
    expect(
      StudioToBridgeMessageSchema.safeParse({ source: 'ccs-studio', type: 'enter-text-edit', requestId: 'r1' })
        .success,
    ).toBe(false);
    expect(
      BridgeToStudioMessageSchema.safeParse({
        source: 'ccs-bridge',
        type: 'text-edit-exit',
        uid: 'a',
        committed: true,
        text: 'x',
        extra: true,
      }).success,
    ).toBe(false);
  });
});
