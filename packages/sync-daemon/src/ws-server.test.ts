import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasOp, DaemonEvent, ProjectInfo } from '@ccs/protocol';
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

  it('sends the ADR-0012 bootstrap ProjectInfo as the first message (no envelope, no `t` field)', async () => {
    const port = await allocatePort(59210);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
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
    });

    const client = await connect(port);
    await client.next(); // bootstrap

    const op: CanvasOp = { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'hi' };
    client.socket.send(JSON.stringify({ kind: 'canvas-op', opId: 'op-1', op }));

    await vi.waitFor(() => expect(onCanvasOp).toHaveBeenCalledWith(op, 'op-1'));
  });

  it('replies with op-rejected for a structurally invalid CanvasOp, without calling onCanvasOp', async () => {
    const port = await allocatePort(59240);
    const onCanvasOp = vi.fn();
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp,
      onSetGeometry: () => {},
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

  it('tracks clientCount as clients connect and disconnect', async () => {
    const port = await allocatePort(59260);
    handle = createControlServer({
      port,
      getBootstrap: () => ({ ...BOOTSTRAP, daemonPort: port }),
      onCanvasOp: () => {},
      onSetGeometry: () => {},
    });

    expect(handle.clientCount()).toBe(0);
    const client = await connect(port);
    await client.next();
    await vi.waitFor(() => expect(handle?.clientCount()).toBe(1));

    client.socket.close();
    await vi.waitFor(() => expect(handle?.clientCount()).toBe(0));
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
