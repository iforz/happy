import * as React from 'react';
import { Platform, Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { completeTokenHubLogin, saveTokenHubLogin, hasMatchingWebLogin } from '@/integrations/tokenhub/login';
import { nativeHandoff } from '@/integrations/tokenhub/nativeHandoff';
export default function TokenHubCallback() {
    const auth = useAuth(), router = useRouter(); const [message, setMessage] = React.useState('正在验证登录…');
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
            await saveTokenHubLogin(await completeTokenHubLogin(url), auth.login); router.replace('/');
        })().catch(e => setMessage(e instanceof Error ? e.message : '登录失败，请重新开始。'));
    }, [auth, router]);
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 24 }}><Text accessibilityRole="header">{message}</Text>{nativeUrl ? <Pressable onPress={() => window.location.assign(nativeUrl)}><Text>打开 Work App</Text></Pressable> : null}<Pressable onPress={() => router.replace('/')}><Text>返回 Work</Text></Pressable><Pressable onPress={() => router.push('/restore')}><Text>恢复原有加密身份</Text></Pressable></View>;
}
