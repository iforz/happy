import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import { reloadAppAsync } from 'expo';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { apiSocket } from '@/sync/apiSocket';
import { revokeTokenHubSession, unregisterPushForLogout } from '@/integrations/tokenhub/logout';
import { saveSessionNotice, clearSessionNotice } from '@/integrations/tokenhub/logoutNotice';
import { preserveTokenHubIdentity, clearTokenHubLocalSession, watchTokenHubSession, invalidateTokenHubLogin } from '@/integrations/tokenhub/sessionLifecycle';
import { isTokenHubSessionForUI } from '@/integrations/tokenhub/sessionSource';
import { NativeSessionStopNotice } from '@/integrations/tokenhub/NativeSessionStopNotice';
import { requiresRuntimeRestart, markRuntimeRestartRequired, RUNTIME_RESTART_MESSAGE } from '@/integrations/tokenhub/runtimeRestart';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    restartRequired: boolean;
    cleanupRequired: boolean;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials && !requiresRuntimeRestart());
    const [credentials, setCredentials] = useState<AuthCredentials | null>(requiresRuntimeRestart() ? null : initialCredentials);
    const [restartRequired, setRestartRequired] = useState(requiresRuntimeRestart);
    // Keep the invalidation watcher alive even after the UI has stopped exposing old credentials.
    const [watchedCredentials, setWatchedCredentials] = useState(initialCredentials);
    const [cleanupRequired, setCleanupRequired] = useState(!!initialCredentials && requiresRuntimeRestart());
    type RemoteStatus = 'confirmed' | 'unconfirmed' | null;
    const [remoteLogoutStatus, setRemoteLogoutStatus] = useState<RemoteStatus>(null);
    type PendingCleanup = { credentials: AuthCredentials | null; notice: string | null; reloadWeb: boolean; remoteStatus?: RemoteStatus };
    const pendingCleanup = React.useRef<PendingCleanup | null>(null);
    const cleanupPromise = React.useRef<Promise<void> | null>(null);
    const authGeneration = React.useRef(0);
    const logoutActive = React.useRef(false);
    const credentialMutations = React.useRef(Promise.resolve());
    const mutateCredentials = async <T,>(action: () => Promise<T>): Promise<T> => {
        const previous = credentialMutations.current;
        let release!: () => void;
        credentialMutations.current = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
    };

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(isAuthenticated && credentials ? { isAuthenticated, credentials, restartRequired, cleanupRequired, login, logout } : null);
    }, [isAuthenticated, credentials, restartRequired, cleanupRequired]);

    const restartNativeRuntime = async () => {
        if (Platform.OS === 'web') return;
        markRuntimeRestartRequired(); setRestartRequired(true);
        try { await reloadAppAsync('TokenHub authorization cleared'); } catch { /* The welcome UI exposes the required manual restart and blocks new login. */ }
    };

    const stopLocalAuthorization = (pending: PendingCleanup) => {
        pendingCleanup.current = pending;
        setRemoteLogoutStatus(pending.remoteStatus ?? null);
        authGeneration.current += 1;
        invalidateTokenHubLogin();
        if (Platform.OS !== 'web') markRuntimeRestartRequired();
        // This is an in-memory stop, not a claim that SecureStore deletion succeeded.
        setCurrentAuth(null); setCredentials(null); setIsAuthenticated(false); setCleanupRequired(true);
        apiSocket.disconnect();
    };

    const finishLocalCleanup = async (): Promise<void> => {
        if (cleanupPromise.current) return cleanupPromise.current;
        const pending = pendingCleanup.current;
        if (!pending) return;
        const work = (async () => {
            await preserveTokenHubIdentity(pending.credentials);
            await mutateCredentials(async () => {
                if (!await TokenStorage.removeCredentials()) throw new Error('Could not remove local credentials');
            });
            // Do not drop expiry/foreground metadata until credential deletion has succeeded.
            await clearTokenHubLocalSession();
            clearPersistence();
            if (pending.notice) await saveSessionNotice(pending.notice); else await clearSessionNotice();
            pendingCleanup.current = null;
            setWatchedCredentials(null); setCleanupRequired(false);
            if (pending.reloadWeb && Platform.OS === 'web') window.location.reload();
            else await restartNativeRuntime();
        })();
        cleanupPromise.current = work;
        try { await work; } finally { if (cleanupPromise.current === work) cleanupPromise.current = null; }
    };

    useEffect(() => watchTokenHubSession(watchedCredentials, async () => {
        if (logoutActive.current) throw new Error('Logout is already in progress');
        if (!pendingCleanup.current) stopLocalAuthorization({ credentials: watchedCredentials, reloadWeb: false,
            notice: '会话已到期、撤销或因网络环境变化而失效，请重新统一登录。原有加密身份已安全保留。' });
        await finishLocalCleanup();
    }), [watchedCredentials]);

    const login = async (token: string, secret: string) => {
        if (cleanupRequired || pendingCleanup.current || restartRequired || requiresRuntimeRestart()) throw new Error(RUNTIME_RESTART_MESSAGE);
        if (logoutActive.current) throw new Error('退出正在进行，请稍后重新登录。');
        const operation = ++authGeneration.current;
        const newCredentials: AuthCredentials = { token, secret };
        const success = await mutateCredentials(async () => {
            if (authGeneration.current !== operation) throw new Error('登录已取消，请重新开始。');
            return TokenStorage.setCredentials(newCredentials);
        });
        const rejectStale = async () => {
            if (authGeneration.current === operation) return;
            await mutateCredentials(async () => {
                if ((await TokenStorage.getCredentials())?.token === token) await TokenStorage.removeCredentials();
            });
            if (requiresRuntimeRestart()) apiSocket.disconnect();
            throw new Error('登录已取消，请重新开始。');
        };
        await rejectStale();
        if (success) {
            await clearSessionNotice();
            await syncCreate(newCredentials);
            await rejectStale();
            setCredentials(newCredentials); setWatchedCredentials(newCredentials);
            setIsAuthenticated(true);
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const logout = async () => {
        if (logoutActive.current) return;
        logoutActive.current = true; authGeneration.current += 1;
        invalidateTokenHubLogin();
        try {
            if (!pendingCleanup.current) {
                trackLogout();
                const unifiedSession = credentials !== null && isTokenHubSessionForUI(credentials.token);
                const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
                // Complete the bounded remote attempt before closing the native Work request gate.
                const [revoked] = await Promise.all([
                    credentials && unifiedSession ? revokeTokenHubSession(credentials.token) : Promise.resolve(false),
                    credentials && registeredPushToken ? unregisterPushForLogout(credentials.token, registeredPushToken) : Promise.resolve(),
                ]);
                stopLocalAuthorization({ credentials, reloadWeb: true, remoteStatus: unifiedSession ? revoked ? 'confirmed' : 'unconfirmed' : null, notice: unifiedSession
                    ? revoked ? '已退出，并已确认撤销当前 TokenHub 会话。' : '本机已退出，远端撤销未确认。请联系管理员确认远端会话是否已撤销。'
                    : null });
            }
            // A repeated logout retries only local deletion, preserving the first remote outcome.
            await finishLocalCleanup();
        } finally { logoutActive.current = false; }
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                restartRequired,
                cleanupRequired,
                login,
                logout,
            }}
        >
            {children}
            <NativeSessionStopNotice cleanupRequired={cleanupRequired} restartRequired={restartRequired} remoteStatus={remoteLogoutStatus} retry={logout} />
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
