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
    const login = async () => { try { setError(''); const result = await beginTokenHubLogin(); if (result) await saveTokenHubLogin(result, auth.login); } catch (e) { setError(e instanceof Error ? e.message : '登录暂不可用。'); } };
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.groupped.background }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 520, gap: 22 }}>
            {c.logoUrl ? <Image source={{ uri: c.logoUrl }} accessibilityLabel={c.brandName} style={{ width: 72, height: 72, alignSelf: 'center' }} resizeMode="contain" /> : null}
            <Text style={{ color: theme.colors.text, fontSize: 24, fontWeight: '600', textAlign: 'center' }}>{c.brandName}</Text>
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 32, fontWeight: '600', textAlign: 'center' }}>{c.title}</Text>
            <Text style={{ color: theme.colors.textSecondary, lineHeight: 24, textAlign: 'center' }}>{c.subtitle}</Text>
            {c.showLogin && c.ssoReady && !offline && !blocked ? <RoundButton title={c.loginLabel} action={login} /> : null}
            {(c.showLocalLogin || !c.ssoReady || offline) && !blocked ? <><RoundButton title="使用已有 Happy 身份／设备登录" onPress={restore} /><Pressable onPress={() => { void create(); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>创建本地加密身份</Text></Pressable></> : null}
            {auth.cleanupRequired ? <><Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>此会话已停用，但本机凭据尚未清除。请解锁设备后重试清理；清理成功前不会自动重启或重新登录。</Text><RoundButton title="重试本机退出清理" action={async () => { try { setError(''); await auth.logout(); } catch { setError('本机清理尚未成功，请解锁设备后重试。'); } }} /></> : null}
            {auth.restartRequired && !auth.cleanupRequired ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{RUNTIME_RESTART_MESSAGE}</Text> : null}
            {offline && !blocked ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>连接暂不可用，仍可使用设备登录。</Text> : null}
            {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{error}</Text> : null}
            {notice ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{notice}</Text> : null}
            {Platform.OS !== 'web' ? <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>统一登录会话到期后需重新登录。退出统一登录时会尝试撤销当前 TokenHub 会话；原有加密身份仍安全保留在此设备。</Text> : null}
            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{c.footerText}</Text>
            {c.helpUrl ? <Pressable onPress={() => { void Linking.openURL(c.helpUrl); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>帮助</Text></Pressable> : null}
        </View>
    </ScrollView>;
}
