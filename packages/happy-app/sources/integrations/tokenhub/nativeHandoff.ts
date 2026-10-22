import { getServerUrl } from '@/sync/serverConfig';

/** HTTPS callback bridge only. The device's completion secret never enters the browser. */
export async function nativeHandoff(url: string): Promise<string | null> {
    const input = new URL(url), state = input.searchParams.get('state');
    const code = input.searchParams.get('code'), error = input.searchParams.get('error');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || input.searchParams.getAll('state').length !== 1
        || input.searchParams.getAll('code').length > 1 || input.searchParams.getAll('error').length > 1
        || Boolean(code) === Boolean(error) || error && error !== 'access_denied' || code && code.length > 128) return null;
    const response = await fetch(getServerUrl() + '/v1/tokenhub/native/handoff', { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, ...(error ? { error } : { code }) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const data = await response.json(), target = new URL(data.callbackUrl);
    if (target.protocol !== 'happy:' || target.hostname !== 'tokenhub' || target.pathname !== '/callback'
        || target.port || target.username || target.password || target.hash
        || target.searchParams.get('state') !== state || target.searchParams.get('code') !== code || target.searchParams.get('error') !== error
        || [...target.searchParams.keys()].some(key => !['state', 'code', 'error'].includes(key))
        || target.searchParams.getAll('state').length !== 1 || target.searchParams.getAll('code').length > 1 || target.searchParams.getAll('error').length > 1) throw new Error('登录回跳地址无效。');
    return target.toString();
}
