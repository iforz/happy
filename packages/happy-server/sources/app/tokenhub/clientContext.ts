import { isIP } from 'node:net';

interface RequestPeer {
    socket?: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
}

function normalizeIP(value: string): string {
    const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
    return isIP(normalized) ? normalized : '';
}

/** The deployment's loopback proxy must overwrite X-Real-IP with $remote_addr.
 * Never consume browser-controlled forwarding chains, even from a trusted peer.
 */
export function workClientContext(request: RequestPeer, trust = process.env.TOKENHUB_TRUST_LOOPBACK_PROXY) {
    if (trust && trust !== 'true' && trust !== 'false') throw new Error('Invalid loopback proxy trust mode');
    const peer = normalizeIP(request.socket?.remoteAddress ?? '');
    let ip = peer;
    if (trust === 'true' && (peer === '127.0.0.1' || peer === '::1')) {
        const forwarded = request.headers['x-real-ip'];
        if (typeof forwarded !== 'string' || !normalizeIP(forwarded) || forwarded !== forwarded.trim()) {
            throw new Error('Trusted proxy omitted a single valid client IP');
        }
        ip = normalizeIP(forwarded);
    }
    return { ip, userAgent: request.headers['user-agent'] as string | undefined };
}
