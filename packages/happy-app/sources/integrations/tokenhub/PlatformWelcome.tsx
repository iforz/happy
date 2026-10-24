import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/RoundButton';
import { usePageConfig } from './usePageConfig';
import { usePlatformSession } from './PlatformSessionProvider';
import { beginPlatformLogin } from './platformSession';
import { workText as t } from './workText';

/** Ordinary Work access never offers device-key recovery as a login fallback. */
export function PlatformWelcome() {
    const { config, offline, reload } = usePageConfig(), auth = usePlatformSession(), { theme } = useUnistyles();
    const [error, setError] = React.useState('');
    const login = async () => { try { setError(''); await beginPlatformLogin(); } catch { setError(t('loginError')); } };
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.groupped.background }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View style={{ maxWidth: 520, width: '100%', gap: 22 }}>
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 32, textAlign: 'center' }}>Work</Text>
            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{t('cloudDescription')}</Text>
            {auth.status === 'loading' ? <Text style={{ color: theme.colors.text }}>{t('checkingLogin')}</Text> : null}
            {auth.status === 'ready' && !offline && config.ssoReady && config.showLogin ? <RoundButton title={t('signIn')} action={login} /> : null}
            {auth.status === 'error' || offline || (auth.status === 'ready' && !config.ssoReady) ? <>
                <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{t('loginError')}</Text>
                <RoundButton title={t('retryLogin')} action={async () => { reload(); await auth.refresh(); }} />
            </> : null}
            {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{error}</Text> : null}
        </View>
    </ScrollView>;
}
