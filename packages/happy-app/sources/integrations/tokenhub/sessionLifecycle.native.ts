import { AppState } from 'react-native';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeLoginStorage } from './nativeLoginStorage';
import { cancelNativeLogin, invalidateNativeLogin } from './login.native';
import { nativeFetch } from './nativeTransport';
import { requiresRuntimeRestart } from './runtimeRestart.native';

export async function preserveTokenHubIdentity(credentials: AuthCredentials | null) {
    if (credentials) await nativeLoginStorage.saveIdentity(credentials.secret);
}
export const clearTokenHubLocalSession = cancelNativeLogin;
export const invalidateTokenHubLogin = invalidateNativeLogin;

/** Native expiry clears the session, not the encryption identity. No synthetic token refresh. */
export function watchTokenHubSession(credentials: AuthCredentials | null, expired: () => Promise<void>): () => void {
    if (!credentials) return () => {};
    let disposed = false, invalidating = false, invalidationPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
    const invalidate = async () => {
        if (!disposed && !invalidating) {
            invalidationPending = true; invalidating = true;
            active?.abort();
            try { await expired(); } catch { invalidating = false; /* Retry on the next foreground check if secure storage was unavailable. */ }
        }
    };
    const check = async () => {
        try {
            if (invalidationPending || requiresRuntimeRestart()) { await invalidate(); return; }
            const session = await nativeLoginStorage.session();
            if (disposed || session?.token !== credentials.token || session.server !== getServerUrl().replace(/\/+$/, '')) return;
            if (timer) clearTimeout(timer);
            if (session.expiresAt !== null) {
                if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) { await invalidate(); return; }
                timer = setTimeout(() => { void invalidate(); }, Math.min(session.expiresAt - Date.now(), 2147483647));
            }
            active?.abort(); const controller = new AbortController(); active = controller;
            const timeout = setTimeout(() => controller.abort(), 2500);
            try {
                const response = await nativeFetch(session.server + '/v1/tokenhub/native/session', { credentials: 'omit', redirect: 'error', cache: 'no-store',
                    headers: { Authorization: `Bearer ${credentials.token}` }, signal: controller.signal });
                if (!disposed && active === controller && response.status === 401) await invalidate();
            } finally { clearTimeout(timeout); }
        } catch { /* Network failures never extend the server-provided expiry or manufacture a fresh token. */ }
    };
    void check();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void check(); });
    return () => { disposed = true; if (timer) clearTimeout(timer); active?.abort(); subscription.remove(); };
}
