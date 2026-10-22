import { LoginFlows, type LoginFlow } from './flow';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const NATIVE_WORK_USER_AGENT = 'TokenHubWorkNative/1';
export interface NativeLoginFlow extends LoginFlow { nativeBindingHash: string; nativeClientIP: string }
export function canonicalNativeIP(ip: string): string {
    if (isIP(ip) === 4) return ip;
    if (isIP(ip) !== 6) throw new Error('native_context_changed');
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
    if (mapped) {
        const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
        return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
    return normalized;
}
export function nativeRequestBinding(ip: string, userAgent: string | undefined): string {
    const canonicalIP = canonicalNativeIP(ip);
    if (userAgent !== NATIVE_WORK_USER_AGENT) throw new Error('native_context_changed');
    return createHash('sha256').update(canonicalIP.trim() + '\n' + userAgent.trim()).digest('hex').slice(0, 32);
}

/** A separate store prevents native credentials from weakening the browser cookie flow. */
export class NativeLoginFlows {
    private readonly flows: LoginFlows;
    private readonly pending = new Map<string, { expires: number; nativeBindingHash: string; nativeClientIP: string }>();
    constructor(private readonly now = Date.now) { this.flows = new LoginFlows(now); }
    start(publicKey: string, nativeBindingHash: string, nativeClientIP: string): NativeLoginFlow {
        if (!/^[a-f0-9]{32}$/.test(nativeBindingHash)) throw new Error('Invalid native binding');
        if (canonicalNativeIP(nativeClientIP) !== nativeClientIP) throw new Error('Invalid native IP');
        for (const [state, value] of this.pending) if (value.expires <= this.now()) this.pending.delete(state);
        const flow = this.flows.start(publicKey);
        this.pending.set(flow.state, { expires: flow.expires, nativeBindingHash, nativeClientIP });
        return { ...flow, nativeBindingHash, nativeClientIP };
    }
    has(state: string): boolean { return (this.pending.get(state)?.expires ?? 0) > this.now(); }
    consume(state: string, binding: string, nativeBindingHash: string): NativeLoginFlow {
        const flow = this.flows.consume(state, binding);
        const context = this.pending.get(state);
        this.pending.delete(state);
        if (!context || context.nativeBindingHash !== nativeBindingHash) throw new Error('native_context_changed');
        return { ...flow, nativeBindingHash: context.nativeBindingHash, nativeClientIP: context.nativeClientIP };
    }
}

// This is not caller-configurable. The intercepted URI alone cannot complete login.
export const NATIVE_LOGIN_CALLBACK = 'happy://tokenhub/callback';
