import * as React from 'react';
import { Platform, Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { completeTokenHubLogin, identitySaved } from '@/integrations/tokenhub/login';
export default function TokenHubCallback() {
    const auth = useAuth(), router = useRouter(); const [message, setMessage] = React.useState('正在验证登录…');
    const started = React.useRef(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || started.current) return; started.current = true;
        void completeTokenHubLogin(window.location.href).then(async result => { await auth.login(result.token, result.secret); identitySaved(); router.replace('/'); }).catch(e => setMessage(e instanceof Error ? e.message : '登录失败，请重新开始。'));
    }, [auth, router]);
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 24 }}><Text accessibilityRole="header">{message}</Text><Pressable onPress={() => router.replace('/')}><Text>返回 Work</Text></Pressable><Pressable onPress={() => router.push('/restore')}><Text>恢复原有加密身份</Text></Pressable></View>;
}
