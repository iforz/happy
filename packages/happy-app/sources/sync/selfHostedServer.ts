/** A self-hosted build must never fall back to the upstream relay or saved account. */
export function pinnedSelfHostedServer(enabled: string | undefined, configured: string | undefined): string | null {
    if (enabled !== '1') return null;
    if (!configured) throw new Error('Self-hosted builds require EXPO_PUBLIC_HAPPY_SERVER_URL.');
    const url = new URL(configured);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash || !['/', '/work', '/work/'].includes(url.pathname)) {
        throw new Error('Self-hosted relay must be an HTTPS origin (HTTP is allowed only on loopback).');
    }
    return url.origin + (url.pathname.startsWith('/work') ? '/work' : '');
}
