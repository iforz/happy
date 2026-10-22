/** Public display contract. Contains no credentials, billing data or executable markup. */
export interface HappyPageConfig {
    schemaVersion: 1; revision: string; brandName: string; title: string; subtitle: string; loginLabel: string; footerText: string;
    websiteUrl?: string; downloadUrl?: string; communityUrl?: string; sourceUrl?: string; privacyUrl?: string; termsUrl?: string;
    logoUrl: string; helpUrl: string; loginUrl: string; showLogin: boolean; showLocalLogin: boolean; ssoReady: boolean;
}
export const defaultPageConfig: HappyPageConfig = { schemaVersion: 1, revision: 'default', brandName: 'Work', title: 'Your AI workspace', subtitle: 'Secure access to your encrypted sessions.', loginLabel: 'Sign in with TokenHub', footerText: 'Your encryption keys stay on your devices.', websiteUrl: '', downloadUrl: '', communityUrl: '', sourceUrl: '', privacyUrl: '', termsUrl: '', logoUrl: '', helpUrl: '', loginUrl: '', showLogin: false, showLocalLogin: true, ssoReady: false };
export function validatePageConfig(raw: unknown): HappyPageConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid display configuration');
    const o = raw as Record<string, unknown>; const c = { ...defaultPageConfig };
    if (o.schemaVersion !== 1) throw new Error('Unsupported configuration schema');
    for (const k of ['revision', 'brandName', 'title', 'subtitle', 'loginLabel', 'footerText', 'logoUrl', 'helpUrl', 'loginUrl'] as const) {
        const v = o[k]; if (typeof v !== 'string' || v.length > (k.endsWith('Url') ? 2048 : 1000) || /[\x00\r]/.test(v)) throw new Error('Invalid display value'); c[k] = v;
    }
    for (const k of ['websiteUrl', 'downloadUrl', 'communityUrl', 'sourceUrl', 'privacyUrl', 'termsUrl'] as const) { const v = o[k] ?? ''; if (typeof v !== 'string' || v.length > 2048) throw new Error('Invalid display URL'); c[k] = v; }
    for (const k of ['showLogin', 'showLocalLogin', 'ssoReady'] as const) { if (typeof o[k] !== 'boolean') throw new Error('Invalid display flag'); c[k] = o[k]; }
    if (!c.brandName.trim() || !c.title.trim() || !c.loginLabel.trim() || (!c.showLogin && !c.showLocalLogin)) throw new Error('Missing display values');
    for (const rawUrl of [c.logoUrl, c.helpUrl, c.loginUrl, c.websiteUrl, c.downloadUrl, c.communityUrl, c.sourceUrl, c.privacyUrl, c.termsUrl]) {
        if (!rawUrl) continue; const u = new URL(rawUrl); if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Unsafe URL');
    }
    if (c.logoUrl) { const u = new URL(c.logoUrl); if (u.search || u.pathname.toLowerCase().endsWith('.svg')) throw new Error('Unsafe image URL'); }
    return c;
}
export function validateLoginOrigin(c: HappyPageConfig, trustedOrigin: string): HappyPageConfig {
    if (c.loginUrl) { const u = new URL(c.loginUrl); if (u.origin !== new URL(trustedOrigin).origin || u.pathname !== '/happy/authorize' || u.search) throw new Error('Untrusted login target'); }
    return c;
}
