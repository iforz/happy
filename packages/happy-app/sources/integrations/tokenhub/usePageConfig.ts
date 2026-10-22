import * as React from 'react';
import { Platform } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { defaultPageConfig, validatePageConfig, validateLoginOrigin, type HappyPageConfig } from './pageConfig';
import { readCachedConfig } from './pageCache';
export function usePageConfig() {
    const key = 'happy-display:v1:' + getServerUrl();
    const [config, setConfig] = React.useState<HappyPageConfig>(() => { if (Platform.OS !== 'web') return defaultPageConfig; try { return readCachedConfig(localStorage, key) ?? defaultPageConfig; } catch { return defaultPageConfig; } });
    const [offline, setOffline] = React.useState(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let disposed = false; let active: AbortController | undefined;
        const refresh = async () => {
            active?.abort(); const controller = new AbortController(); active = controller;
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const r = await fetch(getServerUrl() + '/v1/tokenhub/config', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
                if (!r.ok) throw new Error(); const body = await r.json(); const value = validateLoginOrigin(validatePageConfig(body.config), body.tokenHubOrigin);
                if (disposed || active !== controller) return; setConfig(value); setOffline(false); document.title = `${value.title} · ${value.brandName}`;
                try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), config: value, origin: body.tokenHubOrigin })); } catch { /* Display works without cache. */ }
            } catch { if (!disposed && active === controller) { setConfig(c => ({ ...c, ssoReady: false })); setOffline(true); } }
            finally { clearTimeout(timer); }
        };
        void refresh(); const focus = () => { void refresh(); }; window.addEventListener('focus', focus);
        return () => { disposed = true; active?.abort(); window.removeEventListener('focus', focus); };
    }, [key]);
    return { config, offline };
}
