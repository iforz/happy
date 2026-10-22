import * as React from 'react';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/RoundButton';
import { usePageConfig } from './usePageConfig';
import { beginTokenHubLogin } from './login';
export function TokenHubWelcome({ restore, create }: { restore: () => void; create: () => Promise<void> }) {
    const { config: c, offline } = usePageConfig(); const { theme } = useUnistyles(); const [error, setError] = React.useState('');
    const login = async () => { try { await beginTokenHubLogin(); } catch (e) { setError(e instanceof Error ? e.message : '登录暂不可用。'); } };
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.groupped.background }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 520, gap: 22 }}>
            {c.logoUrl ? <Image source={{ uri: c.logoUrl }} accessibilityLabel={c.brandName} style={{ width: 72, height: 72, alignSelf: 'center' }} resizeMode="contain" /> : null}
            <Text style={{ color: theme.colors.text, fontSize: 24, fontWeight: '600', textAlign: 'center' }}>{c.brandName}</Text>
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 32, fontWeight: '600', textAlign: 'center' }}>{c.title}</Text>
            <Text style={{ color: theme.colors.textSecondary, lineHeight: 24, textAlign: 'center' }}>{c.subtitle}</Text>
            {c.showLogin && c.ssoReady && !offline ? <RoundButton title={c.loginLabel} action={login} /> : null}
            {(c.showLocalLogin || !c.ssoReady || offline) ? <><RoundButton title="使用已有 Happy 身份／设备登录" onPress={restore} /><Pressable onPress={() => { void create(); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>创建本地加密身份</Text></Pressable></> : null}
            {offline ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>连接暂不可用，仍可使用设备登录。</Text> : null}
            {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{error}</Text> : null}
            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>{c.footerText}</Text>
            {c.helpUrl ? <Pressable onPress={() => { void Linking.openURL(c.helpUrl); }}><Text style={{ color: theme.colors.textSecondary, textAlign: 'center' }}>帮助</Text></Pressable> : null}
        </View>
    </ScrollView>;
}
