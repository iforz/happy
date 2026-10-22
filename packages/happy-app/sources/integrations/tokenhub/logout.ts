import { getServerUrl } from '@/sync/serverConfig';
import { tokenHubFetch } from './transport';

/** Attempts only the signed session's own family. Never sends a client-supplied SID or identity. */
export async function revokeTokenHubSession(token: string): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            (async () => {
                const response = await tokenHubFetch(getServerUrl() + '/v1/tokenhub/logout', { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
                return response.ok && (await response.json()).revoked === true;
            })(),
            new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 2200); }),
        ]);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** Never use the general push API's indefinite backoff during sign-out. */
export async function unregisterPushForLogout(token: string, pushToken: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            tokenHubFetch(getServerUrl() + '/v1/push-tokens/' + encodeURIComponent(pushToken), {
                method: 'DELETE', credentials: 'omit', redirect: 'error', cache: 'no-store',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: controller.signal,
            }),
            new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 1200); }),
        ]);
    } catch { /* Remote revocation and local cleanup must still proceed. */ }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
}
