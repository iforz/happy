import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io';
import { protectWorkSocket } from './socketAuthorization';
import { WORK_REVALIDATE_MS, type WorkAuthorization } from './workAuthorization';

function setup(expiresIn = 60_000) {
    vi.useFakeTimers();
    const socket = new EventEmitter() as EventEmitter & { use: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; handshake: unknown; request: unknown };
    socket.handshake = { address: '127.0.0.1', headers: { 'user-agent': 'test' } };
    socket.request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'user-agent': 'test' } };
    socket.use = vi.fn(); socket.disconnect = vi.fn(() => socket.emit('disconnect'));
    const initial = { userId: 'happy-a', expiresAt: Date.now() + expiresIn };
    const verifyToken = vi.fn().mockResolvedValue(initial);
    const authorization: WorkAuthorization = { enabled: true, verifyToken, verifyGrant: vi.fn() };
    protectWorkSocket(socket as unknown as Socket, 'signed-happy', initial, authorization);
    return { socket, verifyToken, initial, inbound: socket.use.mock.calls[0][0] as (packet: unknown[], next: (error?: Error) => void) => Promise<void> };
}
afterEach(() => vi.useRealTimers());

it('reauthorizes each protected event, including future/unrecognized event names', async () => {
    const f = setup(); const next = vi.fn();
    await f.inbound(['rpc-call', {}], next); await f.inbound(['a-future-handler', {}], next);
    expect(next.mock.calls).toEqual([[], []]); expect(f.verifyToken).toHaveBeenCalledTimes(2);
    f.verifyToken.mockResolvedValue(null); await f.inbound(['session-update', {}], next);
    expect(next.mock.lastCall?.[0]).toBeInstanceOf(Error); expect(f.socket.disconnect).toHaveBeenCalledWith(true); expect(vi.getTimerCount()).toBe(0);
});

it.each(['revoked', 'disabled', 'authority-down'])('disconnects an idle socket after %s without waiting for a client event', async () => {
    const f = setup(); f.verifyToken.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(WORK_REVALIDATE_MS);
    expect(f.verifyToken).toHaveBeenCalledTimes(1); expect(f.socket.disconnect).toHaveBeenCalledWith(true); expect(vi.getTimerCount()).toBe(0);
});

it('disconnects exactly at known expiry even when revalidation is hanging', async () => {
    const f = setup(16_000); f.verifyToken.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('does not dispatch a pending authorized event after disconnection', async () => {
    const f = setup(); let resolve!: (value: typeof f.initial) => void;
    f.verifyToken.mockImplementation(() => new Promise(r => { resolve = r; }));
    const next = vi.fn(); const pending = f.inbound(['rpc-call'], next);
    f.socket.emit('disconnect'); resolve(f.initial); await pending;
    expect(next).toHaveBeenCalledWith(expect.any(Error)); expect(vi.getTimerCount()).toBe(0);
});

it('cleans all timers on ordinary disconnect and never rechecks again', async () => {
    const f = setup(); f.socket.emit('disconnect'); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.verifyToken).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('does not install new restrictions in upstream mode', () => {
    const socket = { use: vi.fn() };
    protectWorkSocket(socket as unknown as Socket, 'legacy', { userId: 'upstream' }, { enabled: false, verifyToken: vi.fn(), verifyGrant: vi.fn() });
    expect(socket.use).not.toHaveBeenCalled();
});
