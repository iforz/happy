import { workText as t } from './workText';
import * as React from 'react';
import { Image, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/RoundButton';
import { usePageConfig } from './usePageConfig';
import { beginTokenHubLogin, saveTokenHubLogin } from './login';
import { useAuth } from '@/auth/AuthContext';
import { readSessionNotice } from './logoutNotice';
import { RUNTIME_RESTART_MESSAGE } from './runtimeRestart';
export function TokenHubWelcome({ restore, create }: { restore: () => void; create: () => Promise<void> }) {
    const { config: c, offline } = usePageConfig(); const { theme } = useUnistyles(); const [error, setError] = React.useState('');
    const auth = useAuth();
    const blocked = auth.restartRequired || auth.cleanupRequired;
    const [notice, setNotice] = React.useState<string | null>(null);
    React.useEffect(() => { let disposed = false; void readSessionNotice().then(value => { if (!disposed) setNotice(value); }); return () => { disposed = true; }; }, [auth.cleanupRequired, auth.restartRequired]);
    const login = async () => { try { setError(''); const result = await beginTokenHubLogin(); if (result) await saveTokenHubLogin(result, auth.login); } catch (e) { setError(e instanceof Error ? e.message : t('loginError')); } };
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.groupped.background }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 520, gap: 22 }}>
            {c.logoUrl ? <Image source={{ uri: c.logoUrl }} accessibilityLabel={c.brandName} style={{ width: 72, height: 72, alignSelf: 'center' }} resizeMode="contain" /> : null}
            <Text style={{ color: theme.colors.text, fontSize: 24, fontWeight: '600', textAlign: 'center' }}>{c.brandName}</Text>
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 32, fontWeight: '600', textAlign: 'center' }}>{c.title}</Text>
            <Text style={{ color: theme.colors.textSecondary, lineHeight: 24, textAlign: 'center' }}>{c.subtitle}</Text>
            {c.showLogin && c.ssoReady && !offline && !blocked ? <RoundButton title={c.loginLabel} action={login} /> : null}
            {(c.showLocalLogin || !c.ssoReady || offline) && !blocked ? <><RoundButton title={t('restore')} onPress={restore} /><Pressable onPress={() => { void create(); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{t('createIdentity')}</Text></Pressable></> : null}
            {auth.cleanupRequired ? <><Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{t('cleanup')}</Text><RoundButton title={t('retryCleanup')} action={async () => { try { setError(''); await auth.logout(); } catch { setError(t('cleanupError')); } }} /></> : null}
            {auth.restartRequired && !auth.cleanupRequired ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{t('restart')}</Text> : null}
            {offline && !blocked ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{t('offline')}</Text> : null}
            {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{error}</Text> : null}
            {notice ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{notice}</Text> : null}
            {Platform.OS !== 'web' ? <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{t('nativeSession')}</Text> : null}
            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{c.footerText}</Text>
            {c.helpUrl ? <Pressable onPress={() => { void Linking.openURL(c.helpUrl); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{t('help')}</Text></Pressable> : null}
        </View>
    </ScrollView>;
}
