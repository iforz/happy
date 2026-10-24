import * as React from 'react';
import { Platform, Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { completeTokenHubLogin, saveTokenHubLogin, hasMatchingWebLogin } from '@/integrations/tokenhub/login';
import { nativeHandoff } from '@/integrations/tokenhub/nativeHandoff';
import { usePlatformSession } from '@/integrations/tokenhub/PlatformSessionProvider';
import { hasPlatformLogin } from '@/integrations/tokenhub/platformSession';
import { workText as t } from '@/integrations/tokenhub/workText';
export default function TokenHubCallback() {
    const platform = usePlatformSession();
    // A previous device/native flow remains deliberately separate from platform sign-in.
    const [platformFlow] = React.useState(() => platform.status !== 'disabled' && (hasPlatformLogin(window.location.href) || !hasMatchingWebLogin(window.location.href)));
    if (platformFlow) return <PlatformCallback />;
    return <DeviceCallback />;
}
function PlatformCallback() {
    const auth = usePlatformSession(), router = useRouter();
    const [message, setMessage] = React.useState(t('checkingLogin'));
    const started = React.useRef(false);
    React.useEffect(() => {
        if (started.current) return; started.current = true;
        void (async () => {
            const url = window.location.href;
            if (!hasPlatformLogin(url)) {
                // Preserve the registered native handoff without treating a missing
                // platform flow as permission to start a Happy identity recovery.
                const target = await nativeHandoff(url);
                if (target) { window.history.replaceState(null, '', window.location.pathname); window.location.assign(target); return; }
            }
            await auth.complete(url); router.replace('/');
        })().catch(() => setMessage(t('loginError')));
    }, [auth.complete, router]);
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 24 }}>
        <Text accessibilityRole="header">{message}</Text>
        <Pressable onPress={() => router.replace('/')}><Text>{t('returnWork')}</Text></Pressable>
    </View>;
}
function DeviceCallback() {
    const auth = useAuth(), router = useRouter(), platform = usePlatformSession(); const [message, setMessage] = React.useState('正在验证登录…');
    const started = React.useRef(false);
    const [nativeUrl, setNativeUrl] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || started.current) return; started.current = true;
        void (async () => {
            const url = window.location.href;
            if (!hasMatchingWebLogin(url)) {
                const target = await nativeHandoff(url);
                if (target) {
                    window.history.replaceState(null, '', window.location.pathname);
                    setNativeUrl(target); setMessage('请返回手机上的 Work，完成统一登录。');
                    window.location.assign(target); return;
                }
            }
            await saveTokenHubLogin(await completeTokenHubLogin(url), auth.login); router.replace(platform.status !== 'disabled' ? '/device-agents' : '/');
        })().catch(e => setMessage(e instanceof Error ? e.message : '登录失败，请重新开始。'));
    }, [auth, router]);
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 24 }}><Text accessibilityRole="header">{message}</Text>{nativeUrl ? <Pressable onPress={() => window.location.assign(nativeUrl)}><Text>打开 Work App</Text></Pressable> : null}<Pressable onPress={() => router.replace('/')}><Text>返回 Work</Text></Pressable><Pressable onPress={() => router.push('/restore')}><Text>恢复原有加密身份</Text></Pressable></View>;
}
