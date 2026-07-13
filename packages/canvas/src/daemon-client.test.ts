import { describe, expect, it, vi } from 'vitest';
import { connectDaemon, type MinimalSocket } from './daemon-client.js';

class FakeSocket implements MinimalSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function connectWithFake() {
  const socket = new FakeSocket();
  const handlers = {
    onProjectInfo: vi.fn(),
    onEvent: vi.fn(),
    onControlReply: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  };
  const client = connectDaemon('ws://127.0.0.1:4700', handlers, () => socket);
  return { socket, handlers, client };
}

describe('connectDaemon', () => {
  it('routes the bootstrap ProjectInfo (no `t`) to onProjectInfo', () => {
    const { socket, handlers } = connectWithFake();
    const info = { frames: [], daemonPort: 4700 };
    socket.emitMessage(info);
    expect(handlers.onProjectInfo).toHaveBeenCalledWith(info);
    expect(handlers.onEvent).not.toHaveBeenCalled();
  });

  it('routes a DaemonEvent (has `t`) to onEvent', () => {
    const { socket, handlers } = connectWithFake();
    const event = { t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' };
    socket.emitMessage(event);
    expect(handlers.onEvent).toHaveBeenCalledWith(event);
    expect(handlers.onProjectInfo).not.toHaveBeenCalled();
  });

  it('routes multiple sequential events in order', () => {
    const { socket, handlers } = connectWithFake();
    socket.emitMessage({ frames: [], daemonPort: 4700 });
    socket.emitMessage({ t: 'hmr-update', file: 'a' });
    socket.emitMessage({ t: 'file-changed', file: 'a' });
    expect(handlers.onProjectInfo).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledTimes(2);
  });

  it('reports malformed JSON via onError, never throws', () => {
    const { socket, handlers } = connectWithFake();
    expect(() => socket.onmessage?.({ data: 'not json{' })).not.toThrow();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it('reports a structurally-invalid message via onError', () => {
    const { socket, handlers } = connectWithFake();
    socket.emitMessage({ t: 'totally-unknown-event' });
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it('forwards open/close/error lifecycle callbacks', () => {
    const { socket, handlers } = connectWithFake();
    socket.onopen?.();
    socket.onclose?.();
    socket.onerror?.(new Error('boom'));
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it('sendSetGeometry sends the exact ADR-0013 envelope', () => {
    const { socket, client } = connectWithFake();
    client.sendSetGeometry('demo', 'src/frames/Hero.tsx', { x: 1, y: 2, w: 3, h: 4 });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      kind: 'set-geometry',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    });
  });

  it('sendCanvasOp sends the exact ADR-0013 envelope', () => {
    const { socket, client } = connectWithFake();
    const op = { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'hi' } as const;
    client.sendCanvasOp(op, 'op-1');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'canvas-op', opId: 'op-1', op });
  });

  it('sendCreateFrame sends the exact ADR-0014 envelope', () => {
    const { socket, client } = connectWithFake();
    client.sendCreateFrame('demo', 'Testimonials', 'req-1');
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      kind: 'create-frame',
      requestId: 'req-1',
      fileFolder: 'demo',
      name: 'Testimonials',
    });
  });

  it('sendGetCanvasJson sends the exact ADR-0014 envelope', () => {
    const { socket, client } = connectWithFake();
    client.sendGetCanvasJson('demo', 'req-2');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'get-canvas-json', requestId: 'req-2', fileFolder: 'demo' });
  });

  it('routes an ADR-0014 ControlReply (has `kind`, no `t`) to onControlReply', () => {
    const { socket, handlers } = connectWithFake();
    const reply = { kind: 'control-error', requestId: 'req-1', reason: 'boom' };
    socket.emitMessage(reply);
    expect(handlers.onControlReply).toHaveBeenCalledWith(reply);
    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onProjectInfo).not.toHaveBeenCalled();
  });

  it('close() closes the underlying socket', () => {
    const { socket, client } = connectWithFake();
    client.close();
    expect(socket.closed).toBe(true);
  });
});
