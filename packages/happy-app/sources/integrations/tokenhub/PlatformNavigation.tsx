import * as React from 'react';
import { ActivityIndicator, ScrollView } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { SidebarNavigator, useSidebarActions } from '@/components/SidebarNavigator';
import { FlatSessionRowView } from '@/components/FlatSessionRow';
import { Avatar } from '@/components/Avatar';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import { workText as t } from './workText';

export type PlatformNavigationItem = { id: string; title: string; updatedAt: number; model?: string };
export type PlatformNavigationSnapshot = {
    items: readonly PlatformNavigationItem[];
    selectedId?: string;
    busy?: boolean;
    loading?: boolean;
};
const EMPTY: PlatformNavigationSnapshot = { items: [] };
const SnapshotContext = React.createContext<PlatformNavigationSnapshot>(EMPTY);
const RegistrationContext = React.createContext<React.Dispatch<React.SetStateAction<PlatformNavigationSnapshot>> | null>(null);

/** Scope changes discard all cached account summaries. No credentials or message bodies live here. */
export function PlatformNavigationProvider({ scope, children }: { scope: string; children: React.ReactNode }) {
    return <PlatformNavigationState key={scope}>{children}</PlatformNavigationState>;
}
function PlatformNavigationState({ children }: { children: React.ReactNode }) {
    const [snapshot, register] = React.useState<PlatformNavigationSnapshot>(EMPTY);
    return <RegistrationContext.Provider value={register}><SnapshotContext.Provider value={snapshot}>{children}</SnapshotContext.Provider></RegistrationContext.Provider>;
}

/** The home controller publishes summaries; settings routes keep the original sidebar visible. */
export function usePlatformNavigationRegistration(snapshot: PlatformNavigationSnapshot): void {
    const register = React.useContext(RegistrationContext);
    React.useEffect(() => {
        register?.({ items: snapshot.items.map(({ id, title, updatedAt, model }) => ({ id, title, updatedAt, model })), selectedId: snapshot.selectedId, busy: snapshot.busy, loading: snapshot.loading });
    }, [register, snapshot.items, snapshot.selectedId, snapshot.busy, snapshot.loading]);
    React.useEffect(() => () => { register?.(previous => ({ ...previous, busy: false, loading: false })); }, [register]);
}

function PlatformHistoryList({ snapshot }: { snapshot: PlatformNavigationSnapshot }) {
    const router = useRouter();
    const sidebar = useSidebarActions();
    const { theme } = useUnistyles();
    return <ScrollView style={{ flex: 1 }}>
        {snapshot.loading && !snapshot.items.length ? <ActivityIndicator color={theme.colors.textSecondary} /> : null}
        {snapshot.items.map((item, index) => <FlatSessionRowView key={item.id}
            title={item.title || t('newChat')} selected={snapshot.selectedId === item.id} showBorder={index < snapshot.items.length - 1}
            avatar={<Avatar id={item.id} size={60} badgeLocation="sessionList" />}
            timestamp={formatSessionListTimestamp(item.updatedAt)} projectName={item.model}
            onPressProps={{ accessibilityRole: 'button', accessibilityLabel: item.title || t('newChat'), onPress: () => { sidebar.close(); router.navigate({ pathname: '/', params: { conversationId: item.id } }); } }}
        />)}
    </ScrollView>;
}

/** Original Happy navigation chrome, driven by account summaries rather than device sessions. */
export function PlatformNavigationLayout({ children }: { children: React.ReactNode }) {
    const snapshot = React.useContext(SnapshotContext);
    const router = useRouter();
    const pathname = usePathname();
    return <SidebarNavigator platform={{
        sidebar: {
            children: <PlatformHistoryList snapshot={snapshot} />,
            onNew: () => router.navigate({ pathname: '/', params: { newChat: randomUUID() } }),
            onSettings: () => router.push('/settings'),
            newLabel: t('newChat'), settingsLabel: t('settings'), busy: snapshot.busy,
        },
        onBack: () => { if (router.canGoBack()) router.back(); else router.navigate('/'); },
        canGoBack: pathname !== '/',
        children,
    }} />;
}
