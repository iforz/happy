import path from 'node:path';

export function productionWebEnvironment(root, source = process.env) {
    // Do not inherit dev-auth variables, analytics keys or ambient provider keys.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']
        .filter(key => source[key]).map(key => [key, source[key]]));
    return {
        ...env,
        HOME: path.join(root, '.happy-web-local/build-home'),
        USERPROFILE: path.join(root, '.happy-web-local/build-home'),
        XDG_CACHE_HOME: path.join(root, '.happy-web-local/build-cache'),
        APP_ENV: 'production',
        EXPO_NO_DOTENV: '1',
        EXPO_NO_TELEMETRY: '1',
        EXPO_OFFLINE: '1',
        EXPO_PUBLIC_SELF_HOSTED: '1',
        HAPPY_BUILD_TARGET: 'web',
        EXPO_PUBLIC_DISABLE_ANALYTICS: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://ai.iforz.cn',
        CI: '1',
    };
}
