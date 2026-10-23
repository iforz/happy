const UPSTREAM_NAMESPACE = /^(com\.(slopus|ex3ndr)|engineering\.happy)(\.|$)/i;

function requireOwnIdentifier(env, key, pattern) {
    const value = env[key];
    if (!value || !pattern.test(value) || UPSTREAM_NAMESPACE.test(value)) {
        throw new Error(`Self-hosted native builds require ${key} with your own valid application identifier; upstream Happy identifiers are not allowed.`);
    }
    return value;
}

function validateWorkOrigin(value, target) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Self-hosted builds require EXPO_PUBLIC_HAPPY_SERVER_URL as a valid Work HTTPS origin.');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const localWeb = target === 'web' && url.protocol === 'http:' && loopback;
    if ((url.protocol !== 'https:' && !localWeb) || url.username || url.password
        || !(url.pathname === '/' || (target === 'web' && ['/work', '/work/'].includes(url.pathname))) || url.search || url.hash) {
        throw new Error('EXPO_PUBLIC_HAPPY_SERVER_URL must be a Work HTTPS origin without credentials, path, query or fragment (HTTP loopback is allowed only for web).');
    }
}

/** Keep legacy builds unchanged; self-hosted builds must never inherit upstream service identity. */
function withSelfHostedBuildConfig(config, env = process.env) {
    if (env.EXPO_PUBLIC_SELF_HOSTED !== '1') return config;

    const target = env.HAPPY_BUILD_TARGET || 'native';
    if (!['native', 'web'].includes(target)) {
        throw new Error('HAPPY_BUILD_TARGET must be native or web.');
    }
    if (target === 'web' && [env.EAS_BUILD_PLATFORM, env.EXPO_OS].some(value => ['ios', 'android'].includes(value))) {
        throw new Error('HAPPY_BUILD_TARGET=web cannot be used for an iOS or Android build. Use native and supply your own application identifiers.');
    }
    validateWorkOrigin(env.EXPO_PUBLIC_HAPPY_SERVER_URL, target);

    const result = {
        ...config,
        platforms: target === 'web' ? ['web'] : ['ios', 'android'],
        // No update URL/channel or inherited signing metadata. Cold starts use this build's embedded bundle.
        updates: { enabled: false, checkAutomatically: 'NEVER', useEmbeddedUpdate: true },
        plugins: (config.plugins || []).filter(plugin =>
            (Array.isArray(plugin) ? plugin[0] : plugin) !== 'expo-notifications'),
        extra: { ...config.extra, app: { ...config.extra?.app } },
    };
    delete result.owner;
    delete result.runtimeVersion;
    delete result.extra.eas;
    delete result.extra.app.elevenLabsAgentId;

    if (target === 'web') {
        // Web builds have no native application identity and cannot be reused as native config.
        delete result.ios;
        delete result.android;
        result.plugins.push('./plugins/withSelfHostedWebOnly.js');
        return result;
    }

    result.ios = {
        ...config.ios,
        bundleIdentifier: requireOwnIdentifier(env, 'HAPPY_IOS_BUNDLE_IDENTIFIER', /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
        infoPlist: {
            ...config.ios?.infoPlist,
            NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        },
        entitlements: { ...config.ios?.entitlements },
    };
    result.android = {
        ...config.android,
        package: requireOwnIdentifier(env, 'HAPPY_ANDROID_PACKAGE', /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
        intentFilters: [],
    };
    delete result.ios.associatedDomains;
    delete result.ios.googleServicesFile;
    delete result.ios.entitlements['com.apple.developer.associated-domains'];
    delete result.ios.entitlements['aps-environment'];
    if (Array.isArray(result.ios.infoPlist.UIBackgroundModes)) {
        result.ios.infoPlist.UIBackgroundModes = result.ios.infoPlist.UIBackgroundModes.filter(mode => mode !== 'remote-notification');
    }
    delete result.android.googleServicesFile;
    return result;
}

module.exports = { withSelfHostedBuildConfig };
