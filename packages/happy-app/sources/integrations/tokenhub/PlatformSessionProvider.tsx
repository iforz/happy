import * as React from 'react';
import { Platform } from 'react-native';
import { platformSessionEnabled, readPlatformSession, completePlatformLogin, endPlatformSession, readPlatformSignOutIntent, rememberPlatformSignOut, clearPlatformSignOutIntent, matchesPlatformSignOut, type PlatformSession } from './platformSession';

type State = { status: 'disabled' | 'loading' | 'ready' | 'error'; session: PlatformSession | null };
type Context = State & { refresh: () => Promise<void>; complete: (url: string) => Promise<void>; logout: () => Promise<void> };
const Context = React.createContext<Context>({ status: 'disabled', session: null, refresh: async () => {}, complete: async () => {}, logout: async () => {} });
export const usePlatformSession = () => React.useContext(Context);
export function PlatformSessionProvider({ children }: { children: React.ReactNode }) {
    const enabled = Platform.OS === 'web' && platformSessionEnabled();
    const [state, setState] = React.useState<State>({ status: enabled ? 'loading' : 'disabled', session: null });
    const epoch = React.useRef(0), active = React.useRef<AbortController | null>(null);
    const pendingLogout = React.useRef<PlatformSession | null>(null);
    const refresh = React.useCallback(async () => {
        if (!enabled) return;
        const generation = ++epoch.current;
        active.current?.abort(); const controller = new AbortController(); active.current = controller;
        const intent = readPlatformSignOutIntent();
        setState(current => current.session && !pendingLogout.current && !intent ? current : { status: 'loading', session: null });
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            // A failed explicit sign-out must not silently turn into a sign-in on focus/retry.
            if (pendingLogout.current) {
                const pending = pendingLogout.current;
                await endPlatformSession(pending);
                if (epoch.current !== generation) return;
                if (pendingLogout.current === pending) pendingLogout.current = null;
                clearPlatformSignOutIntent(intent, true);
                setState({ status: 'ready', session: null });
                return;
            }
            // If storage was blocked, the URL contains only a stop marker. Do not
            // guess which account to revoke, and never restore it automatically.
            if (intent && 'unknown' in intent) { setState({ status: 'ready', session: null }); return; }
            const session = await readPlatformSession(controller.signal);
            if (epoch.current !== generation) return;
            if (intent) {
                if (session && matchesPlatformSignOut(intent, session)) await endPlatformSession(session);
                if (epoch.current !== generation) return;
                if (!session || matchesPlatformSignOut(intent, session)) clearPlatformSignOutIntent(intent, true);
                // A newer cookie belongs to a different login. Do not log it out
                // or show it on this explicitly signed-out page without a click.
                setState({ status: 'ready', session: null });
            } else setState({ status: 'ready', session });
        } catch { if (epoch.current === generation) setState({ status: 'error', session: null }); }
        finally { clearTimeout(timeout); }
    }, [enabled]);
    React.useEffect(() => {
        if (!enabled) return;
        void refresh();
        const foreground = () => { if (document.visibilityState !== 'hidden') void refresh(); };
        window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground);
        return () => { epoch.current++; active.current?.abort(); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); };
    }, [enabled, refresh]);
    React.useEffect(() => {
        if (!state.session) return;
        const timeout = setTimeout(() => { epoch.current++; active.current?.abort(); setState({ status: 'ready', session: null }); }, Math.min(state.session.expiresAt - Date.now(), 2147483647));
        return () => clearTimeout(timeout);
    }, [state.session]);
    const complete = React.useCallback(async (url: string) => {
        const generation = ++epoch.current; active.current?.abort();
        const session = await completePlatformLogin(url);
        if (generation !== epoch.current) throw new Error('Work sign-in changed. Please retry.');
        // This explicit newer login supersedes any failed sign-out of the old session.
        pendingLogout.current = null;
        clearPlatformSignOutIntent();
        setState({ status: 'ready', session });
    }, []);
    const logout = React.useCallback(async () => {
        const session = pendingLogout.current ?? state.session;
        pendingLogout.current = session;
        rememberPlatformSignOut(session);
        const intent = readPlatformSignOutIntent();
        const generation = ++epoch.current;
        active.current?.abort(); setState({ status: 'loading', session: null });
        try {
            if (session) await endPlatformSession(session);
            if (pendingLogout.current === session) pendingLogout.current = null;
            if (epoch.current === generation) { clearPlatformSignOutIntent(intent, true); setState({ status: 'ready', session: null }); }
        } catch {
            if (epoch.current === generation) setState({ status: 'error', session: null });
            throw new Error('Work sign-out could not be confirmed. Please retry.');
        }
    }, [state.session]);
    return <Context.Provider value={{ ...state, refresh, complete, logout }}>{children}</Context.Provider>;
}
