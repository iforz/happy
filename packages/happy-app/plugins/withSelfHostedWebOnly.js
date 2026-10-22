const { withDangerousMod } = require('expo/config-plugins');

// Expo prebuild only warns for unsupported platforms, so also refuse native mods.
module.exports = function withSelfHostedWebOnly(config) {
    const rejectNativeBuild = () => {
        throw new Error('HAPPY_BUILD_TARGET=web is web-only. Native builds require HAPPY_BUILD_TARGET=native and your own iOS/Android application identifiers.');
    };
    for (const platform of ['ios', 'android']) {
        config = withDangerousMod(config, [platform, rejectNativeBuild]);
    }
    return config;
};
