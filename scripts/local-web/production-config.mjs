import path from 'node:path';
import { isIP } from 'node:net';

export function productionOrigin(raw = 'https://work.mzyai.com') {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.origin !== raw || u.username || u.password || isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) throw new Error('HAPPY_PRODUCTION_ORIGIN must be an exact HTTPS public origin');
    return u.origin;
}

export function productionBasePath(raw = '') {
    if (!['', '/work'].includes(raw)) throw new Error('HAPPY_PRODUCTION_BASE_PATH must be empty or /work');
    return raw;
}

export function productionWebEnvironment(root, source = process.env) {
    if (source.HAPPY_PRODUCTION_PLATFORM_AUTH && !['0', '1'].includes(source.HAPPY_PRODUCTION_PLATFORM_AUTH)) throw new Error('HAPPY_PRODUCTION_PLATFORM_AUTH must be 0 or 1');
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
        EXPO_PUBLIC_HAPPY_SERVER_URL: productionOrigin(source.HAPPY_PRODUCTION_ORIGIN) + productionBasePath(source.HAPPY_PRODUCTION_BASE_PATH),
        EXPO_PUBLIC_WORK_BASE_PATH: productionBasePath(source.HAPPY_PRODUCTION_BASE_PATH),
        EXPO_PUBLIC_TOKENHUB_PLATFORM_AUTH: source.HAPPY_PRODUCTION_PLATFORM_AUTH === '1' ? '1' : '0',
        CI: '1',
    };
}
