import { describe, expect, it, vi } from 'vitest';
import { connectOpsClient, type MinimalSocket } from './ws-ops-client.js';

class FakeSocket implements MinimalSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
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
  };
  const client = connectOpsClient('ws://127.0.0.1:4700', handlers, () => socket);
  return { socket, handlers, client };
}

describe('connectOpsClient', () => {
  it('classifies a bare ProjectInfo (no `t`/`kind`) to onProjectInfo', () => {
    const { socket, handlers } = connectWithFake();
    const info = { frames: [], daemonPort: 4700 };
    socket.emitMessage(info);
    expect(handlers.onProjectInfo).toHaveBeenCalledWith(info);
  });

  it('classifies a DaemonEvent (has `t`) to onEvent', () => {
    const { socket, handlers } = connectWithFake();
    socket.emitMessage({ t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' });
    expect(handlers.onEvent).toHaveBeenCalled();
  });

  it('classifies a ControlReply (has `kind`) to onControlReply', () => {
    const { socket, handlers } = connectWithFake();
    socket.emitMessage({ kind: 'control-error', requestId: 'x', reason: 'nope' });
    expect(handlers.onControlReply).toHaveBeenCalled();
  });

  it('sendOp writes the frozen `{kind:"canvas-op", opId, op}` wire shape (ADR-0013)', () => {
    const { socket, client } = connectWithFake();
    const opId = client.sendOp({ t: 'set-text', uid: 'src/frames/Hero.tsx:d0', text: 'hi' });
    expect(socket.sent).toEqual([{ kind: 'canvas-op', opId, op: { t: 'set-text', uid: 'src/frames/Hero.tsx:d0', text: 'hi' } }]);
  });

  it('sendOp throws on a malformed op rather than sending garbage over the wire', () => {
    const { client } = connectWithFake();
    expect(() => client.sendOp({ t: 'set-text' } as never)).toThrow();
  });

  it('sendUndo/sendRedo write the ADR-0018 control-request shapes', () => {
    const { socket, client } = connectWithFake();
    client.sendUndo('demo');
    client.sendRedo('demo');
    expect(socket.sent[0]).toMatchObject({ kind: 'undo', fileFolder: 'demo' });
    expect(socket.sent[1]).toMatchObject({ kind: 'redo', fileFolder: 'demo' });
  });
});
