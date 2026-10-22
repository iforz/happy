import { trustedJson, trustedTokenHubOrigin, unwrap } from './trusted';
import { validatePageConfig, validateLoginOrigin } from '@slopus/happy-wire';
let cached: { origin: string; value: ReturnType<typeof validatePageConfig>; at: number } | undefined;
export async function loadPageConfig(transport: typeof fetch = fetch, force = false) {
    const origin = trustedTokenHubOrigin();
    if (!force && cached?.origin === origin && Date.now() - cached.at < 15000) return cached.value;
    try {
        const value = validateLoginOrigin(validatePageConfig(unwrap(await trustedJson(origin, '/api/v1/settings/happy', {}, transport))), origin);
        cached = { origin, value, at: Date.now() }; return value;
    } catch (error) {
        if (cached?.origin === origin && Date.now() - cached.at < 86400000) return { ...cached.value, ssoReady: false };
        throw error;
    }
}
