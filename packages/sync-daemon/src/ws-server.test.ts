import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasOp, ControlReply, DaemonEvent, ProjectInfo } from '@ccs/protocol';
import { allocatePort } from './port-pool.js';
import { createControlServer, type ControlServerHandle } from './ws-server.js';

const BOOTSTRAP: ProjectInfo = {
  daemonPort: 0, // overwritten per-test with the actual allocated port
  frames: [
    { framePath: 'files/demo/src/frames/Hero.tsx', name: 'Hero', devServerUrl: 'http://127.0.0.1:5200/?frame=Hero' },
  ],
};

/**
 * A client whose incoming messages are queued from the moment the socket
 * is created (not from whenever a test happens to `await` past `open`) —
 * the server can send the ADR-0012 bootstrap the instant it accepts the
 * connection, which can otherwise race a `once('message', ...)` attached
 * only after `await open` resolves.
 */
interface QueuedClient {
  socket: WebSocket;
  next(): Promise<unknown>;
}

function openClient(port: number): Promise<QueuedClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    });
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        socket: ws,
        next: () =>
          new Promise((res) => {
            const queued = queue.shift();
            if (queued !== undefined || queue.length > 0) res(queued);
            else waiters.push(res);
          }),
      }),
    );
  });
}

describe('createControlServer', () => {
  let handle: ControlServerHandle | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients.length = 0;
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  async function connect(port: number): Promise<QueuedClient> {
    const client = await openClient(port);
    clients.push(client.socket);
    return client;
  }

  it('binds to 127.0.0.1 only (playbook §5.8, BOUNDARIES: loopback-only sockets)', async () => {
    const port = await allocatePort(59200);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    expect(handle.host).toBe('127.0.0.1');

    // Real-world proof, not just the requested bind option: attempt a raw
    // TCP connect from this machine's actual non-loopback interface
    // address and expect it to be refused. If the sandbox has no such
    // interface, this step is skipped (the `host === '127.0.0.1'`
    // assertion above still stands as the documented guarantee).
    const nonLoopback = firstNonLoopbackIPv4();
    if (!nonLoopback) return;

    await expect(connectExpectRefusal(nonLoopback, port)).resolves.toBe(true);
  });

  // ---- AUDIT-6 BLOCKER: WS Origin hardening (playbook §5.8) --------------
  // Binding to 127.0.0.1 only stops OFF-machine attackers, but a malicious
  // webpage open in the user's own browser can still open a
  // `ws://127.0.0.1:<port>` connection — browsers don't sandbox loopback
  // WebSocket connections the way they sandbox cross-origin HTTP. These
  // tests drive the REAL control-ws handshake (not a unit test of the
  // regex alone) to prove the server actually refuses/accepts at the
  // handshake based on the incoming `Origin` header.

  function attemptConnect(port: number, wsOptions?: { origin?: string }): Promise<'open' | 'rejected'> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, wsOptions);
      socket.once('open', () => {
        clients.push(socket);
        resolve('open');
      });
      socket.once('unexpected-response', () => resolve('rejected'));
      socket.once('error', () => resolve('rejected'));
    });
  }

  it('rejects a connection whose Origin header is a real (non-localhost) webpage origin', async () => {
    const port = await allocatePort(59260);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    await expect(attemptConnect(port, { origin: 'http://evil-attacker-page.example' })).resolves.toBe(
      'rejected',
    );
  });

  it('allows a connection with NO Origin header at all (native/non-browser clients — this package\'s own tests and the dev harness)', async () => {
    const port = await allocatePort(59270);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    // A plain `new WebSocket(url)` (no `origin` option) never sends an
    // Origin header at all — this is exactly how every other test in this
    // suite (via `connect()`/`openClient()`) and the real dev harness
    // connect today; must keep working unchanged.
    await expect(attemptConnect(port)).resolves.toBe('open');
  });

  it('allows a connection whose Origin header is http://127.0.0.1:<port> (matches the dev harness origin)', async () => {
    const port = await allocatePort(59280);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    await expect(attemptConnect(port, { origin: 'http://127.0.0.1:5555' })).resolves.toBe('open');
  });

  it('allows a connection whose Origin header is http://localhost:<port>', async () => {
    const port = await allocatePort(59290);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    await expect(attemptConnect(port, { origin: 'http://localhost:3000' })).resolves.toBe('open');
  });

  it('sends the ADR-0012 bootstrap ProjectInfo as the first message (no envelope, no `t` field)', async () => {
    const port = await allocatePort(59210);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    const first = await client.next();

    expect(first).toEqual({ ...BOOTSTRAP, daemonPort: port });
    expect(first).not.toHaveProperty('t');
  });

  it('broadcasts a DaemonEvent to every connected client', async () => {
    const port = await allocatePort(59220);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const clientA = await connect(port);
    const clientB = await connect(port);
    await clientA.next(); // consume bootstrap
    await clientB.next();

    const event: DaemonEvent = { t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' };
    const pendingA = clientA.next();
    const pendingB = clientB.next();
    handle.broadcast(event);

    expect(await pendingA).toEqual(event);
    expect(await pendingB).toEqual(event);
  });

  it('forwards a valid canvas-op envelope to onCanvasOp', async () => {
    const port = await allocatePort(59230);
    const onCanvasOp = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp,
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    const op: CanvasOp = { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'hi' };
    client.socket.send(JSON.stringify({ kind: 'canvas-op', opId: 'op-1', op }));

    await vi.waitFor(() => expect(onCanvasOp).toHaveBeenCalledWith(op, 'op-1', undefined));
  });

  it('forwards an explicit fileFolder on a canvas-op envelope (P3 CR — disambiguates multi-file-folder daemons)', async () => {
    const port = await allocatePort(59241);
    const onCanvasOp = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp,
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    const op: CanvasOp = { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'hi' };
    client.socket.send(JSON.stringify({ kind: 'canvas-op', opId: 'op-2', op, fileFolder: 'demo' }));

    await vi.waitFor(() => expect(onCanvasOp).toHaveBeenCalledWith(op, 'op-2', 'demo'));
  });

  it('replies with op-rejected for a structurally invalid CanvasOp, without calling onCanvasOp', async () => {
    const port = await allocatePort(59240);
    const onCanvasOp = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp,
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'canvas-op', opId: 'op-2', op: { t: 'not-a-real-op' } }));
    const reply = await client.next();

    expect(reply).toMatchObject({ t: 'op-rejected', opId: 'op-2' });
    expect(onCanvasOp).not.toHaveBeenCalled();
  });

  it('forwards a set-geometry envelope to onSetGeometry', async () => {
    const port = await allocatePort(59250);
    const onSetGeometry = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry,
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(
      JSON.stringify({
        kind: 'set-geometry',
        fileFolder: 'demo',
        framePath: 'src/frames/Hero.tsx',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
      }),
    );

    await vi.waitFor(() =>
      expect(onSetGeometry).toHaveBeenCalledWith({
        fileFolder: 'demo',
        framePath: 'src/frames/Hero.tsx',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
      }),
    );
  });

  it('forwards a create-frame envelope to onCreateFrame with a working reply channel (ADR-0014)', async () => {
    const port = await allocatePort(59270);
    const onCreateFrame = vi.fn((request: { requestId: string }, reply: (r: ControlReply) => void) => {
      reply({ kind: 'control-error', requestId: request.requestId, reason: 'boom' });
    });
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame,
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(
      JSON.stringify({ kind: 'create-frame', requestId: 'req-1', fileFolder: 'demo', name: 'Testimonials' }),
    );

    await vi.waitFor(() =>
      expect(onCreateFrame).toHaveBeenCalledWith(
        { kind: 'create-frame', requestId: 'req-1', fileFolder: 'demo', name: 'Testimonials' },
        expect.any(Function),
      ),
    );

    const reply = await client.next();
    expect(reply).toEqual({ kind: 'control-error', requestId: 'req-1', reason: 'boom' });
  });

  it('forwards a get-canvas-json envelope to onGetCanvasJson and replies only to the requester, not broadcast', async () => {
    const port = await allocatePort(59280);
    const meta = { frames: [], comments: [], zoomBookmarks: [] };
    const onGetCanvasJson = vi.fn(
      (request: { requestId: string; fileFolder: string }, reply: (r: ControlReply) => void) => {
        reply({ kind: 'get-canvas-json-result', requestId: request.requestId, fileFolder: request.fileFolder, meta });
      },
    );
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson,
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const requester = await connect(port);
    const bystander = await connect(port);
    await requester.next(); // bootstrap
    await bystander.next();

    const bystanderNext = bystander.next();
    requester.socket.send(JSON.stringify({ kind: 'get-canvas-json', requestId: 'req-2', fileFolder: 'demo' }));

    const reply = await requester.next();
    expect(reply).toEqual({ kind: 'get-canvas-json-result', requestId: 'req-2', fileFolder: 'demo', meta });

    // the bystander (a second connected client) never receives this
    // direct reply — only the requesting socket does (contrast with
    // `broadcast`, which every client receives).
    const raceResult = await Promise.race([
      bystanderNext.then(() => 'received' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(raceResult).toBe('timeout');
  });

  it('forwards a duplicate-frame envelope to onDuplicateFrame with a working reply channel (ADR-0015)', async () => {
    const port = await allocatePort(59300);
    const onDuplicateFrame = vi.fn((request: { requestId: string }, reply: (r: ControlReply) => void) => {
      reply({
        kind: 'duplicate-frame-result',
        requestId: request.requestId,
        fileFolder: 'demo',
        sourceName: 'Hero',
        newName: 'HeroCopy',
        framePath: 'src/frames/HeroCopy.tsx',
      });
    });
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame,
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(
      JSON.stringify({ kind: 'duplicate-frame', requestId: 'req-3', fileFolder: 'demo', sourceName: 'Hero' }),
    );

    await vi.waitFor(() =>
      expect(onDuplicateFrame).toHaveBeenCalledWith(
        { kind: 'duplicate-frame', requestId: 'req-3', fileFolder: 'demo', sourceName: 'Hero' },
        expect.any(Function),
      ),
    );

    const reply = await client.next();
    expect(reply).toEqual({
      kind: 'duplicate-frame-result',
      requestId: 'req-3',
      fileFolder: 'demo',
      sourceName: 'Hero',
      newName: 'HeroCopy',
      framePath: 'src/frames/HeroCopy.tsx',
    });
  });

  it('replies with control-error for a duplicate-frame request the handler rejects', async () => {
    const port = await allocatePort(59310);
    const onDuplicateFrame = vi.fn((request: { requestId: string }, reply: (r: ControlReply) => void) => {
      reply({ kind: 'control-error', requestId: request.requestId, reason: 'unknown source frame "Ghost"' });
    });
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame,
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(
      JSON.stringify({ kind: 'duplicate-frame', requestId: 'req-4', fileFolder: 'demo', sourceName: 'Ghost' }),
    );

    const reply = await client.next();
    expect(reply).toEqual({ kind: 'control-error', requestId: 'req-4', reason: 'unknown source frame "Ghost"' });
  });

  it('silently drops a structurally invalid duplicate-frame envelope (missing sourceName)', async () => {
    const port = await allocatePort(59320);
    const onDuplicateFrame = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame,
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'duplicate-frame', requestId: 'req-5', fileFolder: 'demo' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onDuplicateFrame).not.toHaveBeenCalled();
  });

  it('silently drops a structurally invalid create-frame envelope (missing requestId)', async () => {
    const port = await allocatePort(59290);
    const onCreateFrame = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame,
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'create-frame', fileFolder: 'demo', name: 'X' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onCreateFrame).not.toHaveBeenCalled();
  });

  it('tracks clientCount as clients connect and disconnect', async () => {
    const port = await allocatePort(59260);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo: () => {},
    });

    expect(handle.clientCount()).toBe(0);
    const client = await connect(port);
    await client.next();
    await vi.waitFor(() => expect(handle?.clientCount()).toBe(1));

    client.socket.close();
    await vi.waitFor(() => expect(handle?.clientCount()).toBe(0));
  });

  it('forwards an undo request to onUndo with a working reply channel', async () => {
    const port = await allocatePort(59410);
    const onUndo = vi.fn((request: { requestId: string; fileFolder: string }, reply: (r: ControlReply) => void) => {
      reply({ kind: 'undo-result', requestId: request.requestId, fileFolder: request.fileFolder, applied: true, file: 'files/demo/src/frames/Hero.tsx' });
    });
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo,
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'undo', requestId: 'u1', fileFolder: 'demo' }));
    const reply = await client.next();
    expect(reply).toEqual({
      kind: 'undo-result',
      requestId: 'u1',
      fileFolder: 'demo',
      applied: true,
      file: 'files/demo/src/frames/Hero.tsx',
    });
  });

  it('forwards a redo request to onRedo with a working reply channel', async () => {
    const port = await allocatePort(59420);
    const onRedo = vi.fn((request: { requestId: string; fileFolder: string }, reply: (r: ControlReply) => void) => {
      reply({ kind: 'redo-result', requestId: request.requestId, fileFolder: request.fileFolder, applied: false, file: null });
    });
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo: () => {},
      onRedo,
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'redo', requestId: 'r1', fileFolder: 'demo' }));
    const reply = await client.next();
    expect(reply).toEqual({ kind: 'redo-result', requestId: 'r1', fileFolder: 'demo', applied: false, file: null });
  });

  it('silently drops a structurally invalid undo envelope (missing fileFolder)', async () => {
    const port = await allocatePort(59430);
    const onUndo = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
      onCreateFrame: () => {},
      onGetCanvasJson: () => {},
      onDuplicateFrame: () => {},
      onUndo,
      onRedo: () => {},
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    client.socket.send(JSON.stringify({ kind: 'undo', requestId: 'u2' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onUndo).not.toHaveBeenCalled();
  });
});

function firstNonLoopbackIPv4(): string | undefined {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function connectExpectRefusal(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    const done = (refused: boolean) => {
      socket.destroy();
      resolve(refused);
    };
    socket.once('connect', () => done(false)); // connected → NOT refused → test should fail
    socket.once('error', () => done(true)); // ECONNREFUSED/EHOSTUNREACH/etc. → refused, as expected
    socket.once('timeout', () => done(true)); // no response at all also counts as "not reachable"
  });
}
