import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { completeTokenHubLogin, saveTokenHubLogin, NATIVE_CALLBACK } from '@/integrations/tokenhub/login.native';

/** Cold-start route. The normal warm flow is handled by the system auth browser. */
export default function NativeTokenHubCallback() {
    const params = useLocalSearchParams(), auth = useAuth(), router = useRouter();
    const [message, setMessage] = React.useState('正在验证登录…');
    const started = React.useRef(false);
    React.useEffect(() => {
        if (started.current) return; started.current = true;
        void (async () => {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                if (Array.isArray(value)) value.forEach(part => query.append(key, part));
                else if (typeof value === 'string') query.append(key, value);
            }
            const result = await completeTokenHubLogin(`${NATIVE_CALLBACK}?${query}`);
            await saveTokenHubLogin(result, auth.login); router.replace('/');
        })().catch(error => setMessage(error instanceof Error ? error.message : '登录失败，请重新开始。'));
    }, [params, auth, router]);
    return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 24 }}>
        <Text accessibilityRole="header">{message}</Text>
        <Pressable onPress={() => router.replace('/')}><Text>返回 Work，重新统一登录</Text></Pressable>
        <Pressable onPress={() => router.push('/restore')}><Text>恢复原有加密身份</Text></Pressable>
    </View>;
}
