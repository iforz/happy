import { decodeBase64 } from '@/encryption/base64';
import { decodeUTF8 } from '@/encryption/text';

/** UI routing only, NOT signature verification or an authorization decision.
 * The logout server independently verifies the signed Happy token and binding.
 * Legacy Happy credentials must not be represented as a Core session family.
 */
export function isTokenHubSessionForUI(token: string): boolean {
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some(part => !part) || token.length > 65536) return false;
        const payload = JSON.parse(decodeUTF8(decodeBase64(parts[1], 'base64url')));
        const grant = payload?.extras?.tokenhub;
        if (payload?.iss !== 'handy' || !grant || typeof grant !== 'object') return false;
        const origin = new URL(grant.authority);
        return origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash
            && typeof grant.authorizationToken === 'string' && grant.authorizationToken.length > 0
            && typeof grant.issuer === 'string' && grant.issuer.length > 0
            && typeof grant.subject === 'string' && grant.subject.length > 0
            && typeof grant.publicKey === 'string' && /^[a-f0-9]{64}$/.test(grant.publicKey);
    } catch { return false; }
}
