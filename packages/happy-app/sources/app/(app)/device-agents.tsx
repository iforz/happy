import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { View, Text } from 'react-native';
import { RoundButton } from '@/components/RoundButton';
import { useAuth } from '@/auth/AuthContext';
import { MainView } from '@/components/MainView';
import { workText as t } from '@/integrations/tokenhub/workText';
export default function DeviceAgents() {
    const auth=useAuth(), router=useRouter();
    if(!auth.isAuthenticated) return <View style={{flex:1,justifyContent:'center',padding:24,gap:20}}>
        <Text>{t('deviceIdentityOnly')}</Text>
        <RoundButton title={t('restore')} onPress={()=>router.push('/restore')} />
        <RoundButton title={t('returnWork')} onPress={()=>router.dismissTo('/')} />
    </View>;
    return <><Stack.Screen options={{title:t('agents')}}/><MainView variant="phone"/></>;
}
