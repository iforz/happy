import { getRandomBytesAsync } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeLoginStorage, type NativeLoginFlow } from './nativeLoginStorage';
import { nativeRequest } from './nativeTransport';
import { requiresRuntimeRestart, RUNTIME_RESTART_MESSAGE } from './runtimeRestart.native';

export const NATIVE_CALLBACK = 'happy://tokenhub/callback';
export interface NativeLoginResult { token: string; secret: string }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
let beginning = false;
let completing: { state: string; promise: Promise<NativeLoginResult> } | null = null;
let saving: { token: string; promise: Promise<void> } | null = null;
let generation = 0;
const resultGenerations = new WeakMap<NativeLoginResult, number>();
function selectedServer() {
    const url = new URL(getServerUrl());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('统一登录需要 HTTPS Work 服务器。');
    return url.origin;
}
function validFlow(flow: NativeLoginFlow | null): flow is NativeLoginFlow {
    try {
        return !!flow && flow.server === selectedServer() && opaque(flow.state) && opaque(flow.binding)
            && typeof flow.secret === 'string' && decodeBase64(flow.secret, 'base64url').length === 32
            && typeof flow.proof === 'string' && flow.proof.length < 512
            && Number.isSafeInteger(flow.expiresAt) && flow.expiresAt > Date.now() && flow.expiresAt <= Date.now() + 300000;
    } catch { return false; }
}
function callback(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'happy:' || parsed.hostname !== 'tokenhub' || parsed.pathname !== '/callback'
        || parsed.port || parsed.username || parsed.password || parsed.hash
        || parsed.searchParams.getAll('state').length !== 1 || !opaque(parsed.searchParams.get('state'))
        || [...parsed.searchParams.keys()].some(key => !['state', 'code', 'error'].includes(key))
        || parsed.searchParams.getAll('code').length > 1 || parsed.searchParams.getAll('error').length > 1
        || parsed.searchParams.has('code') === parsed.searchParams.has('error')) throw new Error('登录回调无效。');
    const code = parsed.searchParams.get('code'), error = parsed.searchParams.get('error');
    if (code !== null && (!code || code.length > 128) || error !== null && error !== 'access_denied') throw new Error('登录回调无效。');
    return { state: parsed.searchParams.get('state')!, ...(code ? { code } : { error: 'access_denied' as const }) };
}
async function cancel(flow: NativeLoginFlow) {
    try { await nativeRequest(flow.server, '/v1/tokenhub/native/complete', { state: flow.state, binding: flow.binding, error: 'access_denied' }); } catch { /* Server state also expires after five minutes. */ }
}
async function clearMatchingFlow(state: string) {
    if ((await nativeLoginStorage.flow())?.state === state) await nativeLoginStorage.clearFlow();
}

export async function beginTokenHubLogin(): Promise<NativeLoginResult> {
    if (requiresRuntimeRestart()) throw new Error(RUNTIME_RESTART_MESSAGE);
    if (beginning) throw new Error('登录正在进行，请完成或取消当前登录。');
    beginning = true;
    const currentGeneration = generation;
    let flow: NativeLoginFlow | null = null;
    try {
        const server = selectedServer();
        const existing = await TokenStorage.getCredentials();
        let secret = existing?.secret ?? await nativeLoginStorage.identity();
        if (!secret) secret = encodeBase64(await getRandomBytesAsync(32), 'base64url');
        const seed = decodeBase64(secret, 'base64url');
        if (seed.length !== 32) throw new Error('请恢复有效的 Happy 身份。');
        await nativeLoginStorage.saveIdentity(secret);
        const previous = await nativeLoginStorage.flow();
        if (previous && previous.server === server) await cancel(previous);
        await nativeLoginStorage.clearFlow();
        const keys = sodium.crypto_sign_seed_keypair(seed);
        const data = await nativeRequest(server, '/v1/tokenhub/native/start', { publicKey: encodeBase64(keys.publicKey) });
        const url = new URL(data.authorizeUrl), origin = new URL(data.tokenHubOrigin);
        if (url.protocol !== 'https:' || origin.protocol !== 'https:' || url.origin !== origin.origin || url.pathname !== '/happy/authorize'
            || url.username || url.password || url.hash || url.searchParams.get('state') !== data.state
            || url.searchParams.get('client_id') !== 'happy-native' || !/^[a-f0-9]{32}$/.test(url.searchParams.get('native_binding_hash') ?? '') || url.searchParams.get('code_challenge_method') !== 'S256'
            || !opaque(data.state) || !opaque(data.binding) || typeof data.proof !== 'string') throw new Error('登录地址无效。');
        flow = { server, secret, state: data.state, binding: data.binding, proof: data.proof, expiresAt: data.expiresAt };
        if (!validFlow(flow) || currentGeneration !== generation || requiresRuntimeRestart()) throw new Error('登录已取消。');
        await nativeLoginStorage.saveFlow(flow);
        const result = await WebBrowser.openAuthSessionAsync(url.toString(), NATIVE_CALLBACK, { preferEphemeralSession: true });
        if (currentGeneration !== generation || requiresRuntimeRestart()) throw new Error('登录已取消。');
        if (result.type !== 'success') throw new Error('登录已取消。');
        return await completeTokenHubLogin(result.url);
    } catch (error) {
        if (flow && !completing) { await cancel(flow); await clearMatchingFlow(flow.state); }
        throw error;
    } finally { beginning = false; }
}

export async function completeTokenHubLogin(url: string): Promise<NativeLoginResult> {
    if (requiresRuntimeRestart()) throw new Error(RUNTIME_RESTART_MESSAGE);
    const values = callback(url);
    if (completing?.state === values.state) return completing.promise;
    const flow = await nativeLoginStorage.flow();
    if (!validFlow(flow)) { await nativeLoginStorage.clearFlow(); throw new Error('登录状态无效或已过期，请重新开始。'); }
    if (flow.state !== values.state) throw new Error('此回调不属于当前登录，请返回最新的登录页面。');
    if (completing?.state === values.state) return completing.promise;
    const currentGeneration = generation;
    const promise = (async () => {
        try {
            if ('error' in values) { await cancel(flow); throw new Error('登录已取消。'); }
            const existing = await TokenStorage.getCredentials();
            if (existing && existing.secret !== flow.secret) { await cancel(flow); throw new Error('当前 Happy 身份已变化，请重新开始登录。'); }
            const keys = sodium.crypto_sign_seed_keypair(decodeBase64(flow.secret, 'base64url'));
            const signature = sodium.crypto_sign_detached(new TextEncoder().encode(flow.proof), keys.privateKey);
            const data = await nativeRequest(flow.server, '/v1/tokenhub/native/complete', { ...values, binding: flow.binding, signature: encodeBase64(signature) });
            if (currentGeneration !== generation || requiresRuntimeRestart()) throw new Error('登录已取消。');
            const current = await TokenStorage.getCredentials();
            if (current && current.secret !== flow.secret) throw new Error('当前 Happy 身份已变化，请重新开始登录。');
            if (typeof data.token !== 'string' || !data.token || data.refresh !== 'reauthenticate'
                || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error('登录响应无效。');
            await nativeLoginStorage.saveSession({ server: flow.server, token: data.token, expiresAt: data.expiresAt });
            const result = { token: data.token, secret: flow.secret };
            resultGenerations.set(result, currentGeneration);
            return result;
        } finally { await clearMatchingFlow(flow.state); }
    })();
    completing = { state: values.state, promise };
    // Retain a successful result until saved, so browser completion and cold-start routing cannot exchange twice.
    void promise.catch(() => { if (completing?.promise === promise) completing = null; });
    return promise;
}

export async function saveTokenHubLogin(result: NativeLoginResult, login: (token: string, secret: string) => Promise<void>) {
    if (requiresRuntimeRestart()) throw new Error(RUNTIME_RESTART_MESSAGE);
    if (resultGenerations.get(result) !== generation) throw new Error('登录已取消，请重新开始。');
    if (saving?.token === result.token) return saving.promise;
    const promise = login(result.token, result.secret).then(() => identitySaved());
    saving = { token: result.token, promise };
    try { await promise; } catch (error) { saving = null; throw error; }
}
export function identitySaved() { completing = null; }
export function invalidateNativeLogin() { generation += 1; completing = null; saving = null; }
export async function cancelNativeLogin() {
    invalidateNativeLogin();
    const flow = await nativeLoginStorage.flow();
    await nativeLoginStorage.clearFlow();
    await nativeLoginStorage.clearSession();
    // Local sign-out is not Core session-family revocation. No panel token is available here.
    if (flow) void cancel(flow);
}
