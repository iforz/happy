import { getServerUrl } from '@/sync/serverConfig';

export interface PlatformSession {
    authority: string;
    issuer: string;
    subject: string;
    sessionId: string;
    expiresAt: number;
    csrf: string;
}
const FLOW = 'tokenhub-platform-flow:v1:';
export function platformAccountScope(session: PlatformSession, server = getServerUrl()): string {
    return JSON.stringify(['tokenhub-platform-v1', server, session.authority, session.issuer, session.subject]);
}
export function platformSessionEnabled(): boolean {
    return process.env.EXPO_PUBLIC_TOKENHUB_PLATFORM_AUTH === '1';
}
function serverUrl(): string {
    const server = new URL(getServerUrl());
    if (server.origin !== window.location.origin || server.username || server.password || server.search || server.hash) throw new Error('Work requires its configured same-origin service.');
    return server.toString().replace(/\/+$/, '');
}
export function parsePlatformSession(value: unknown): PlatformSession {
    const s = value as PlatformSession;
    try {
        const authority = new URL(s.authority);
        if (authority.protocol !== 'https:' || authority.origin !== s.authority || authority.username || authority.password
            || typeof s.issuer !== 'string' || !s.issuer || s.issuer.length > 200
            || typeof s.subject !== 'string' || !/^[1-9][0-9]*$/.test(s.subject)
            || typeof s.sessionId !== 'string' || !s.sessionId || s.sessionId.length > 256
            || !Number.isSafeInteger(s.expiresAt) || s.expiresAt <= Date.now()
            || typeof s.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.csrf)) throw new Error();
        return { authority: s.authority, issuer: s.issuer, subject: s.subject, sessionId: s.sessionId, expiresAt: s.expiresAt, csrf: s.csrf };
    } catch { throw new Error('Work session could not be verified.'); }
}
async function request(path: string, body?: unknown, csrf?: string, signal?: AbortSignal) {
    const response = await fetch(serverUrl() + '/v1/tokenhub/platform/' + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'x-tokenhub-csrf': csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(15000),
    });
    if (response.status === 401 && (path === 'session' || path === 'logout')) return null;
    if (!response.ok) throw new Error('Work sign-in is unavailable. Please retry.');
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Work sign-in is unavailable.');
    return response.json();
}
export async function readPlatformSession(signal?: AbortSignal): Promise<PlatformSession | null> {
    const data = await request('session', undefined, undefined, signal);
    return data === null ? null : parsePlatformSession(data);
}
export async function beginPlatformLogin(): Promise<void> {
    const server = serverUrl();
    const data = await request('start', {});
    const target = new URL(data.authorizeUrl), authority = new URL(data.tokenHubOrigin);
    if (authority.protocol !== 'https:' || authority.origin !== data.tokenHubOrigin || target.origin !== authority.origin
        || target.pathname !== '/happy/authorize' || target.username || target.password || target.hash
        || typeof data.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.state)
        || target.searchParams.get('state') !== data.state || target.searchParams.get('client_id') !== 'happy-web'
        || target.searchParams.get('redirect_uri') !== window.location.origin + '/tokenhub/callback'
        || target.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Work sign-in address is invalid.');
    // Only one-time navigation state, never an authentication token or encryption identity.
    sessionStorage.setItem(FLOW + server, JSON.stringify({ state: data.state, at: Date.now() }));
    window.location.assign(target.toString());
}
export function hasPlatformLogin(url: string): boolean {
    try { return JSON.parse(sessionStorage.getItem(FLOW + serverUrl()) ?? 'null')?.state === new URL(url).searchParams.get('state'); }
    catch { return false; }
}
export async function completePlatformLogin(url: string): Promise<PlatformSession> {
    const key = FLOW + serverUrl(), target = new URL(url);
    if (target.origin !== window.location.origin || !target.pathname.endsWith('/tokenhub/callback')) throw new Error('Work callback is invalid.');
    let flow: { state: string; at: number } | null = null;
    try { flow = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { /* Invalid local navigation state is not an identity. */ }
    window.history.replaceState(null, '', target.pathname);
    if (!flow || !Number.isSafeInteger(flow.at) || flow.at > Date.now() || Date.now() - flow.at > 300000) throw new Error('Work sign-in expired. Please start again.');
    if (target.searchParams.getAll('state').length !== 1 || target.searchParams.get('state') !== flow.state
        || target.searchParams.getAll('code').length > 1 || target.searchParams.getAll('error').length > 1) throw new Error('This callback is not the current Work sign-in.');
    // Claim the one-time callback synchronously before any network await. A replay
    // must not launch a second exchange or erase a newer flow started meanwhile.
    sessionStorage.removeItem(key);
    try {
        if (target.searchParams.has('error')) {
            try { await request('complete', { state: flow.state, error: 'access_denied' }); } catch { /* Server flow also expires. */ }
            throw new Error('Work sign-in was cancelled.');
        }
        const code = target.searchParams.get('code');
        if (!code || code.length > 128) throw new Error('Work sign-in code is missing.');
        return parsePlatformSession(await request('complete', { state: flow.state, code }));
    } finally {
        try { if (JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state === flow.state) sessionStorage.removeItem(key); } catch { /* Do not overwrite newer/unknown navigation state. */ }
    }
}
export async function endPlatformSession(session: PlatformSession): Promise<void> {
    await request('logout', {}, session.csrf);
}
