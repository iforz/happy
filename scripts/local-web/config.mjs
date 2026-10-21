import path from 'node:path';

export function localWebConfig(root, source = process.env) {
    const port = (name, fallback) => {
        const value = source[name] || String(fallback);
        if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
            throw new Error(`${name} must be a port from 1024 to 65535`);
        }
        return Number(value);
    };
    const webPort = port('HAPPY_LOCAL_WEB_PORT', 8081);
    const serverPort = port('HAPPY_LOCAL_SERVER_PORT', 3005);
    if (webPort === serverPort) throw new Error('Web and relay ports must differ');
    const dataDir = path.join(root, '.happy-web-local');
    // Deliberately do not inherit credentials, provider keys or remote storage config.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']
        .filter(key => source[key]).map(key => [key, source[key]]));
    Object.assign(env, {
        HOME: path.join(dataDir, 'home'),
        USERPROFILE: path.join(dataDir, 'home'),
        XDG_CACHE_HOME: path.join(dataDir, 'cache'),
        DATA_DIR: path.join(dataDir, 'relay'),
        PGLITE_DIR: path.join(dataDir, 'relay', 'pglite'),
        DB_PROVIDER: 'pglite',
        // Public fixture, exclusively for disposable loopback development data.
        HANDY_MASTER_SECRET: 'happy-loopback-development-only-never-production',
        HOST: '127.0.0.1',
        PORT: String(serverPort),
        PUBLIC_URL: `http://127.0.0.1:${serverPort}`,
        EXPO_PUBLIC_HAPPY_SERVER_URL: `http://127.0.0.1:${serverPort}`,
        EXPO_PUBLIC_DISABLE_ANALYTICS: '1',
        EXPO_PUBLIC_SELF_HOSTED: '1',
        EXPO_NO_TELEMETRY: '1',
        EXPO_OFFLINE: '1',
        EXPO_NO_DOTENV: '1',
        APP_ENV: 'development',
        CI: '1',
    });
    return { env, dataDir, webPort, serverPort };
}
