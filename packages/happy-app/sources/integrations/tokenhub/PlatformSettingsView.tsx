import * as React from 'react';
import { View, Text, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { HappyEngineeringWordmark } from '@/components/onboarding/HappyEngineeringWordmark';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { usePlatformSession } from './PlatformSessionProvider';
import { PlatformWelcome } from './PlatformWelcome';
import { workText } from './workText';

export type PlatformSettingsProps = { topContentInset?: number; bottomContentInset?: number; onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void };
export function platformAccountURL(authority: string, page: 'profile' | 'purchase' | 'subscriptions'): string {
    const origin = new URL(authority);
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Invalid account authority');
    return new URL('/' + page, origin.origin).href;
}
export function PlatformSettingsView({ topContentInset = 0, bottomContentInset = 0, onScroll, accountOnly = false }: PlatformSettingsProps & { accountOnly?: boolean }) {
    const platform = usePlatformSession(), router = useRouter(), { theme } = useUnistyles();
    const [error, setError] = React.useState('');
    if (platform.status !== 'ready' || !platform.session) return <PlatformWelcome />;
    const account = (page: 'profile' | 'purchase' | 'subscriptions') => { void openExternalUrl(platformAccountURL(platform.session!.authority, page)); };
    return <ItemList style={{ paddingTop: 0 }} containerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }} onScroll={onScroll} scrollEventThrottle={16}>
        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', alignItems: 'center', paddingVertical: 24 }}><HappyEngineeringWordmark height={72} /></View>
        <ItemGroup title={t('settings.account')}>
            <Item title={t('settings.account')} icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />} onPress={() => account('profile')} />
            <Item title={workText('subscriptionCenter')} icon={<Ionicons name="card-outline" size={29} color="#5856D6" />} onPress={() => account('purchase')} />
            <Item title={workText('mySubscriptions')} icon={<Ionicons name="card-outline" size={29} color="#5856D6" />} onPress={() => account('subscriptions')} />
        </ItemGroup>
        {!accountOnly ? <ItemGroup title={t('settings.features')}>
            <Item title={t('settings.appearance')} subtitle={t('settings.appearanceSubtitle')} icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />} onPress={() => router.push('/settings/appearance')} />
            <Item title={t('settingsLanguage.currentLanguage')} icon={<Ionicons name="language-outline" size={29} color="#007AFF" />} onPress={() => router.push('/settings/language')} />
        </ItemGroup> : null}
        <ItemGroup><Item title={workText('signOutWork')} icon={<Ionicons name="log-out-outline" size={29} color={theme.colors.textSecondary} />} onPress={() => { setError(''); void platform.logout().then(() => router.replace('/')).catch(() => setError(workText('loginError'))); }} /></ItemGroup>
        {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{error}</Text> : null}
    </ItemList>;
}
