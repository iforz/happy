import { validatePageConfig, validateLoginOrigin, type HappyPageConfig } from './pageConfig';
const maxAge = 2 * 86400000;
export function readCachedConfig(storage: Pick<Storage, 'getItem'>, key: string, now = Date.now()): HappyPageConfig | null {
    try { const saved = JSON.parse(storage.getItem(key) ?? 'null'); if (!saved || typeof saved.at !== 'number' || now - saved.at > maxAge || saved.at > now) return null; return { ...validateLoginOrigin(validatePageConfig(saved.config), saved.origin), ssoReady: false }; } catch { return null; }
}
