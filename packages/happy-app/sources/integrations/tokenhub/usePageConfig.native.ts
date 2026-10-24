import * as React from 'react';
import { AppState } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { defaultPageConfig, validatePageConfig, validateLoginOrigin, type HappyPageConfig } from './pageConfig';
import { nativeFetch } from './nativeTransport';

export function usePageConfig() {
    const server = getServerUrl();
    const [config, setConfig] = React.useState<HappyPageConfig>(defaultPageConfig);
    const [offline, setOffline] = React.useState(false);
    const [revision, reload] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        let disposed = false, active: AbortController | undefined;
        const refresh = async () => {
            active?.abort(); const controller = new AbortController(); active = controller;
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await nativeFetch(server + '/v1/tokenhub/config', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error();
                const body = await response.json(), value = validateLoginOrigin(validatePageConfig(body.config), body.tokenHubOrigin);
                if (!disposed && active === controller) { setConfig(value); setOffline(false); }
            } catch { if (!disposed && active === controller) { setConfig(value => ({ ...value, ssoReady: false })); setOffline(true); } }
            finally { clearTimeout(timer); }
        };
        void refresh();
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
        return () => { disposed = true; active?.abort(); subscription.remove(); };
    }, [server, revision]);
    return { config, offline, reload };
}
