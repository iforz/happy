import { randomBytes, createHash, timingSafeEqual, createPublicKey, verify as verifySignature } from 'node:crypto';
import jwt from 'jsonwebtoken';
const opaque = () => randomBytes(32).toString('base64url');
export interface LoginFlow { state: string; nonce: string; verifier: string; binding: string; publicKey: string; expires: number; proof: string }
export class LoginFlows {
    private flows = new Map<string, LoginFlow>();
    constructor(private now = () => Date.now()) {}
    start(publicKey: string): LoginFlow {
        const key = Buffer.from(publicKey, 'base64');
        if (key.length !== 32 || key.toString('base64') !== publicKey) throw new Error('Invalid public key');
        for (const [k, f] of this.flows) if (f.expires <= this.now()) this.flows.delete(k);
        if (this.flows.size >= 5000) throw new Error('Too many login requests');
        const state = opaque(), nonce = opaque();
        const flow = { state, nonce, verifier: opaque(), binding: opaque(), publicKey, expires: this.now() + 300000, proof: `happy-tokenhub:v1:${state}:${nonce}:${publicKey}` };
        this.flows.set(state, flow); return flow;
    }
    consume(state: string, binding: string): LoginFlow {
        const f = this.flows.get(state);
        const a = Buffer.from(binding), b = Buffer.from(f?.binding ?? '');
        if (!f || f.expires <= this.now() || a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid or expired login state');
        this.flows.delete(state); return f;
    }
}
export function challengeFor(flow: LoginFlow) { return createHash('sha256').update(flow.verifier).digest('base64url'); }
export function verifyHappyProof(flow: LoginFlow, signature: string): boolean {
    try {
        const bytes = Buffer.from(signature, 'base64'); if (bytes.length !== 64 || bytes.toString('base64') !== signature) return false;
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(flow.publicKey, 'base64').toString('base64url') }, format: 'jwk' });
        return verifySignature(null, Buffer.from(flow.proof), key, bytes);
    } catch { return false; }
}
export function verifyIdentity(token: string, jwks: unknown, issuer: string, nonce: string, now = Date.now(), audience: 'happy-web' | 'happy-native' = 'happy-web') {
    if (token.length > 8192) throw new Error('Invalid identity assertion');
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string' || decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string' || decoded.header.jku || decoded.header.x5u || decoded.header.crit) throw new Error('Invalid assertion header');
    const keys = (jwks as { keys?: Record<string, unknown>[] })?.keys;
    if (!Array.isArray(keys) || keys.length > 8) throw new Error('Invalid signing keys');
    const matches = keys.filter(k => k.kid === decoded.header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
    if (matches.length !== 1) throw new Error('Untrusted signing key');
    const jwk = matches[0];
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || Buffer.from(jwk.n, 'base64url').length < 256) throw new Error('Weak signing key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const c = jwt.verify(token, key, { algorithms: ['RS256'], issuer, audience, clockTimestamp: Math.floor(now / 1000), clockTolerance: 3, maxAge: '90s' });
    if (typeof c === 'string' || c.nonce !== nonce || !c.sub || !/^[1-9][0-9]*$/.test(c.sub) || typeof c.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.jti) || typeof c.exp !== 'number' || typeof c.iat !== 'number' || typeof c.nbf !== 'number' || c.exp > c.iat + 90 || c.iat > now / 1000 + 3 || !(c.aud === audience || Array.isArray(c.aud) && c.aud.length === 1 && c.aud[0] === audience)) throw new Error('Invalid assertion claims');
    return { issuer, subject: c.sub };
}
export function authorizationUrl(loginUrl: string, origin: string, callback: string, flow: LoginFlow, nativeBindingHash?: string) {
    const u = new URL(loginUrl), self = new URL(callback);
    if (u.origin !== origin || u.protocol !== 'https:' || u.pathname !== '/happy/authorize' || u.username || u.password || u.search || u.hash || self.protocol !== 'https:' || self.pathname !== '/tokenhub/callback' || self.search || self.hash || self.username || self.password) throw new Error('Untrusted redirect');
    if (nativeBindingHash !== undefined && !/^[a-f0-9]{32}$/.test(nativeBindingHash)) throw new Error('Invalid native binding');
    u.search = new URLSearchParams({ client_id: nativeBindingHash ? 'happy-native' : 'happy-web', redirect_uri: callback, state: flow.state, nonce: flow.nonce, code_challenge: challengeFor(flow), code_challenge_method: 'S256', ...(nativeBindingHash ? { native_binding_hash: nativeBindingHash } : {}) }).toString(); return u.toString();
}
