import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformSession } from './platformSession';

const f = vi.hoisted(() => ({ enabled: true, os: 'web', read: vi.fn(), complete: vi.fn(), logout: vi.fn(), mount: vi.fn(), unmount: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return f.os; } } }));
vi.mock('./platformSession', () => ({ platformSessionEnabled: () => f.enabled, readPlatformSession: f.read, completePlatformLogin: f.complete, endPlatformSession: f.logout, readPlatformSignOutIntent: () => null, rememberPlatformSignOut: () => {}, clearPlatformSignOutIntent: () => {}, matchesPlatformSignOut: () => false }));
vi.mock('@/auth/tokenStorage', () => { throw new Error('Platform provider must not import Happy credentials'); });
vi.mock('@/auth/AuthContext', () => { throw new Error('Platform provider must not initialize Happy auth'); });
vi.mock('@/encryption/libsodium.lib', () => { throw new Error('Platform provider must not import Happy signing identity'); });
vi.mock('./login', () => { throw new Error('Platform provider must not use legacy login'); });
import { PlatformSessionProvider, usePlatformSession } from './PlatformSessionProvider';

const now = 1_800_000_000_000;
function session(change: Partial<PlatformSession> = {}): PlatformSession {
    return { authority: 'https://accounts.example.test', issuer: 'synthetic-core', subject: '42', sessionId: 'synthetic-session', expiresAt: now + 60_000, csrf: 'c'.repeat(43), ...change };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let renderer: ReturnType<typeof create> | undefined, current: ReturnType<typeof usePlatformSession>;
let browser: EventTarget, page: EventTarget & { visibilityState: string };
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
function Conversation({ value }: { value: PlatformSession }) {
    const [draft] = React.useState('synthetic in-progress draft');
    React.useEffect(() => { f.mount(value.subject); return () => f.unmount(value.subject); }, []);
    return React.createElement('conversation', { subject: value.subject, sessionId: value.sessionId, draft });
}
function Consumer() {
    current = usePlatformSession();
    return current.status === 'ready' && current.session
        ? React.createElement(Conversation, { key: JSON.stringify([current.session.authority, current.session.issuer, current.session.subject, current.session.sessionId]), value: current.session })
        : React.createElement('signed-out', { status: current.status });
}
async function render() {
    await act(async () => { renderer = create(React.createElement(PlatformSessionProvider, { children: React.createElement(Consumer) })); });
}
async function focus() { await act(async () => { browser.dispatchEvent(new Event('focus')); }); }
const visible = () => renderer!.root.findAllByType('conversation');
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    f.enabled = true; f.os = 'web'; f.read.mockReset(); f.complete.mockReset(); f.logout.mockReset(); f.mount.mockClear(); f.unmount.mockClear();
    f.read.mockResolvedValue(session()); f.complete.mockResolvedValue(session()); f.logout.mockResolvedValue(undefined);
    browser = new EventTarget(); page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    storage = { getItem: vi.fn(() => { throw new Error('No Happy credentials exist'); }), setItem: vi.fn(() => { throw new Error('No token persistence allowed'); }), removeItem: vi.fn() };
    vi.stubGlobal('window', browser); vi.stubGlobal('document', page); vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
});
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('cookie-backed platform session provider', () => {
    it('bootstraps a fresh browser without Happy credentials or writing auth tokens', async () => {
        await render(); expect(current.status).toBe('ready'); expect(current.session).toEqual(session()); expect(f.read).toHaveBeenCalledOnce();
        expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(visible()).toHaveLength(1);
    });
    it.each(['disabled', 'native'])('does not initialize platform auth in %s mode', async mode => {
        if (mode === 'disabled') f.enabled = false; else f.os = 'ios';
        await render(); expect(current.status).toBe('disabled'); expect(current.session).toBeNull(); expect(f.read).not.toHaveBeenCalled();
    });
    it('reads the server cookie again on remount rather than requiring seed recovery', async () => {
        await render(); await act(async () => { renderer.unmount(); }); renderer = undefined;
        await render(); expect(f.read).toHaveBeenCalledTimes(2); expect(current.session).toEqual(session()); expect(storage.getItem).not.toHaveBeenCalled();
    });
    it('keeps the existing conversation mounted while checking an unchanged session on foreground', async () => {
        await render(); const read = deferred<PlatformSession>(); f.read.mockReturnValueOnce(read.promise);
        await focus(); expect(current.status).toBe('ready'); expect(visible()).toHaveLength(1); expect(f.unmount).not.toHaveBeenCalled();
        expect(visible()[0].props.draft).toBe('synthetic in-progress draft');
        await act(async () => { read.resolve({ ...session(), expiresAt: now + 120_000 }); await read.promise; });
        expect(f.mount).toHaveBeenCalledOnce(); expect(f.unmount).not.toHaveBeenCalled(); expect(visible()[0].props.draft).toBe('synthetic in-progress draft');
    });
    it('ignores hidden visibility changes and refreshes when the tab becomes visible', async () => {
        await render(); page.visibilityState = 'hidden'; await act(async () => { page.dispatchEvent(new Event('visibilitychange')); }); expect(f.read).toHaveBeenCalledOnce();
        page.visibilityState = 'visible'; await act(async () => { page.dispatchEvent(new Event('visibilitychange')); }); expect(f.read).toHaveBeenCalledTimes(2);
    });
    it('drops the previous account immediately when the cookie resolves to another account', async () => {
        await render(); f.read.mockResolvedValueOnce(session({ subject: '99', sessionId: 'account-b', csrf: 'd'.repeat(43) }));
        await focus(); expect(visible()).toHaveLength(1); expect(visible()[0].props.subject).toBe('99'); expect(f.unmount).toHaveBeenCalledWith('42'); expect(f.mount).toHaveBeenCalledWith('99');
    });
    it('drops the old session after an authoritative signed-out response', async () => {
        await render(); f.read.mockResolvedValueOnce(null); await focus(); expect(current.status).toBe('ready'); expect(current.session).toBeNull(); expect(visible()).toHaveLength(0); expect(f.unmount).toHaveBeenCalledWith('42');
    });
    it('expires locally at the advertised deadline and does not reauthenticate silently', async () => {
        await render(); await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(current.session).toBeNull(); expect(visible()).toHaveLength(0); expect(f.unmount).toHaveBeenCalledWith('42'); expect(f.read).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
    });
    it('fails closed when foreground verification fails instead of falling back to Happy auth', async () => {
        await render(); f.read.mockRejectedValueOnce(new Error('503 synthetic outage')); await focus();
        expect(current.status).toBe('error'); expect(current.session).toBeNull(); expect(visible()).toHaveLength(0); expect(f.complete).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('clears the visible conversation as soon as explicit logout starts', async () => {
        await render(); const end = deferred<void>(); f.logout.mockReturnValueOnce(end.promise); let pending!: Promise<void>;
        await act(async () => { pending = current.logout(); });
        expect(current.session).toBeNull(); expect(visible()).toHaveLength(0); expect(f.logout).toHaveBeenCalledWith(session());
        await act(async () => { end.resolve(); await pending; }); expect(current.status).toBe('ready'); expect(current.session).toBeNull();
    });
    it('does not silently sign in on foreground while an explicit logout still fails', async () => {
        await render(); f.logout.mockRejectedValue(new Error('503 synthetic outage'));
        await act(async () => { await expect(current.logout()).rejects.toThrow('could not be confirmed'); });
        await focus(); expect(current.status).toBe('error'); expect(current.session).toBeNull(); expect(f.read).toHaveBeenCalledOnce(); expect(f.logout).toHaveBeenCalledTimes(2);
        expect(f.logout.mock.calls[1][0]).toEqual(session()); expect(f.complete).not.toHaveBeenCalled();
    });
    it('retries the actual failed logout rather than forgetting it when logout is clicked again', async () => {
        await render(); f.logout.mockRejectedValue(new Error('503 synthetic outage'));
        await act(async () => { await expect(current.logout()).rejects.toThrow('could not be confirmed'); });
        await act(async () => { await expect(current.logout()).rejects.toThrow('could not be confirmed'); });
        await focus(); expect(current.session).toBeNull(); expect(f.read).toHaveBeenCalledOnce(); expect(f.logout).toHaveBeenCalledTimes(3);
    });
    it('a newer explicit login supersedes a failed old logout without retrying old credentials on focus', async () => {
        await render(); f.logout.mockRejectedValue(new Error('503 synthetic outage'));
        await act(async () => { await expect(current.logout()).rejects.toThrow(); });
        const next = session({ subject: '99', sessionId: 'new', csrf: 'd'.repeat(43) });
        f.complete.mockResolvedValueOnce(next); f.read.mockResolvedValueOnce(next);
        await act(async () => { await current.complete('https://work.example.test/work/tokenhub/callback?state=new'); });
        await focus(); expect(current.status).toBe('ready'); expect(current.session).toEqual(next);
        expect(f.logout).toHaveBeenCalledOnce();
    });
    it('can recover only after pending explicit logout is confirmed', async () => {
        await render(); f.logout.mockRejectedValueOnce(new Error('503 synthetic outage'));
        await act(async () => { await expect(current.logout()).rejects.toThrow(); });
        await focus(); expect(f.logout).toHaveBeenCalledTimes(2);
        // Confirming logout must not read and accidentally present a newer cookie.
        expect(f.read).toHaveBeenCalledOnce(); expect(current.status).toBe('ready'); expect(current.session).toBeNull();
    });
    it('an older session response cannot restore the old account after a newer refresh', async () => {
        await render(); const old = deferred<PlatformSession>(); f.read.mockReturnValueOnce(old.promise); await focus();
        const oldSignal = f.read.mock.calls[1][0] as AbortSignal;
        f.read.mockResolvedValueOnce(session({ subject: '99', sessionId: 'new' })); await focus(); expect(oldSignal.aborted).toBe(true);
        await act(async () => { old.resolve(session()); await old.promise; }); expect(current.session?.subject).toBe('99');
    });
    it('a callback that finishes after logout cannot resurrect a cancelled session', async () => {
        f.read.mockResolvedValueOnce(null); await render(); const exchange = deferred<PlatformSession>(); f.complete.mockReturnValueOnce(exchange.promise);
        let pending!: Promise<void>; await act(async () => { pending = current.complete('https://work.example.test/work/tokenhub/callback?state=synthetic'); });
        const result = pending.then(() => null, error => error as Error);
        await act(async () => { await current.logout(); exchange.resolve(session()); await result; });
        expect(await result).toMatchObject({ message: expect.stringContaining('changed') }); expect(current.session).toBeNull(); expect(visible()).toHaveLength(0);
    });
    it('an old logout response cannot clear a newer explicit successful login', async () => {
        await render(); const end = deferred<void>(); f.logout.mockReturnValueOnce(end.promise); let pending!: Promise<void>;
        await act(async () => { pending = current.logout(); });
        f.complete.mockResolvedValueOnce(session({ subject: '99', sessionId: 'new' }));
        await act(async () => { await current.complete('https://work.example.test/work/tokenhub/callback?state=new'); });
        await act(async () => { end.resolve(); await pending; });
        expect(current.status).toBe('ready'); expect(current.session?.subject).toBe('99');
    });
    it('aborts outstanding reads and removes focus listeners on unmount', async () => {
        const read = deferred<PlatformSession>(); f.read.mockReturnValueOnce(read.promise); await render();
        const signal = f.read.mock.calls[0][0] as AbortSignal;
        await act(async () => { renderer.unmount(); }); renderer = undefined; expect(signal.aborted).toBe(true);
        await focus(); expect(f.read).toHaveBeenCalledOnce(); read.resolve(session());
    });
});
