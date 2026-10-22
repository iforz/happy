import { getRandomBytesAsync } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';
const pendingKey = 'happy-tokenhub-pending-identity:v1';
const flowKey = 'happy-tokenhub-flow:v1';
async function request(path: string, body: unknown) {
    const r = await fetch(getServerUrl() + path, { method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { if (r.status === 409) throw new Error('请先恢复原来的 Happy 加密身份，再登录此账号。'); throw new Error('登录未完成或已过期，请重新开始。'); }
    return r.json();
}
export async function beginTokenHubLogin() {
    const existing = await TokenStorage.getCredentials();
    let secret = existing?.secret ?? localStorage.getItem(pendingKey);
    if (!secret) { secret = encodeBase64(await getRandomBytesAsync(32), 'base64url'); localStorage.setItem(pendingKey, secret); }
    const seed = decodeBase64(secret, 'base64url'); if (seed.length !== 32) throw new Error('请恢复有效的 Happy 身份。');
    const key = sodium.crypto_sign_seed_keypair(seed);
    const result = await request('/v1/tokenhub/start', { publicKey: encodeBase64(key.publicKey) });
    const u = new URL(result.authorizeUrl), origin = new URL(result.tokenHubOrigin);
    if (u.protocol !== 'https:' || origin.protocol !== 'https:' || u.origin !== origin.origin || u.pathname !== '/happy/authorize' || u.username || u.password || u.hash || typeof result.state !== 'string' || typeof result.proof !== 'string') throw new Error('登录地址无效。');
    sessionStorage.setItem(flowKey, JSON.stringify({ state: result.state, proof: result.proof, secret, at: Date.now() }));
    window.location.assign(u.toString());
}
export async function completeTokenHubLogin(url: string) {
    const p = new URL(url); const flow = JSON.parse(sessionStorage.getItem(flowKey) ?? 'null');
    // Clear one-time URL parameters promptly; no identity token appears in the URL.
    window.history.replaceState(null, '', p.pathname);
    if (!flow || Date.now() - flow.at > 300000 || flow.at > Date.now() || p.searchParams.getAll('state').length !== 1 || p.searchParams.get('state') !== flow.state || p.searchParams.getAll('code').length > 1 || p.searchParams.getAll('error').length > 1) { sessionStorage.removeItem(flowKey); throw new Error('登录状态无效或已过期，请重新开始。'); }
    try {
        if (p.searchParams.has('error')) {
            try { await request('/v1/tokenhub/complete', { state: flow.state, error: 'access_denied' }); } catch { /* Cancellation also consumes server state. */ } throw new Error('登录已取消。');
        }
        const current = await TokenStorage.getCredentials();
        if (current && current.secret !== flow.secret) {
            try { await request('/v1/tokenhub/complete', { state: flow.state, error: 'access_denied' }); } catch { /* Fail closed and keep the newer local identity. */ }
            throw new Error('当前 Happy 身份已变化，请重新开始登录。');
        }
        const code = p.searchParams.get('code'); if (!code) throw new Error('缺少登录授权码。');
        const seed = decodeBase64(flow.secret, 'base64url'); const keys = sodium.crypto_sign_seed_keypair(seed);
        const signature = sodium.crypto_sign_detached(new TextEncoder().encode(flow.proof), keys.privateKey);
        const data = await request('/v1/tokenhub/complete', { state: flow.state, code, signature: encodeBase64(signature) });
        if (typeof data.token !== 'string' || !data.token) throw new Error('登录响应无效。');
        return { token: data.token, secret: flow.secret as string };
    } finally { sessionStorage.removeItem(flowKey); }
}
export function identitySaved() { try { localStorage.removeItem(pendingKey); } catch { /* Existing credential persistence already succeeded. */ } }
