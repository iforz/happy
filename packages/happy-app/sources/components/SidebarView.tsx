import { DEVICE_SESSION_ROUTE } from '@/integrations/tokenhub/newSessionRoute';
import { useAuth } from '@/auth/AuthContext';
import { isTokenHubSessionForUI } from '@/integrations/tokenhub/sessionSource';
import { usePathname } from 'expo-router';
import { workText } from '@/integrations/tokenhub/workText';
import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus, useSettingMutable } from '@/sync/storage';
import { MainView } from './MainView';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';
import { useHasArchivedSessions } from '@/hooks/useVisibleSessionListViewData';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    topControls: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        gap: 8,
    },
    newSessionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    newSessionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    archiveButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    archiveButtonActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    shortcutTargetActive: {
        backgroundColor: theme.colors.surfacePressed,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 10,
    },
    settingsText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default(),
    },
    shortcutBadgeInline: {
        marginLeft: 'auto',
    },
}));

const DeviceSidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const hasArchivedSessions = useHasArchivedSessions();
    // Stored under its original `hideInactiveSessions` key — synced settings
    // have no rename migration — but it hides archived sessions only.
    const [hideArchivedSessions, setHideArchivedSessions] = useSettingMutable('hideInactiveSessions');
    const { visible: shortcutHintsVisible } = useShortcutHints();

    const handleNewSession = React.useCallback(() => {
        router.navigate(DEVICE_SESSION_ROUTE);
    }, [router]);
    const handleArchiveVisibility = React.useCallback(() => {
        setHideArchivedSessions(!hideArchivedSessions);
    }, [hideArchivedSessions, setHideArchivedSessions]);
    const auth = useAuth(), pathname = usePathname();
    if (auth.credentials && isTokenHubSessionForUI(auth.credentials.token) && pathname !== '/device-agents') {
        return <View style={[styles.container,{paddingTop:safeArea.top+headerHeight,paddingHorizontal:16,gap:18}]}>
            {[['title','/'],['settings','/settings']].map(([key,url])=><Pressable key={url} accessibilityRole="button" onPress={()=>router.push(url as any)} style={{padding:12}}><Text style={styles.newSessionText}>{workText(key as 'title'|'settings')}</Text></Pressable>)}
        </View>;
    }
    return <SidebarFrame
        newLabel={t('sidebar.newSession')} settingsLabel={t('settings.title')}
        onNew={handleNewSession} onSettings={() => router.push('/settings')}
        shortcutHintsVisible={shortcutHintsVisible}
        archiveControl={hasArchivedSessions ? (<Pressable
                        onPress={handleArchiveVisibility}
                        accessibilityLabel={hideArchivedSessions
                            ? t('sidebar.showArchived')
                            : t('sidebar.hideArchived')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !hideArchivedSessions }}
                        style={({ pressed }) => [
                            styles.archiveButton,
                            !hideArchivedSessions && styles.archiveButtonActive,
                            pressed && styles.newSessionButtonPressed,
                        ]}
                    >
                        <Ionicons
                            name={hideArchivedSessions ? 'archive-outline' : 'archive'}
                            size={18}
                            color={stylesheet.newSessionText.color}
                        />
                    </Pressable>) : null}
        status={realtimeStatus !== 'disconnected' ? <VoiceAssistantStatusBar variant="sidebar" /> : null}
    ><MainView variant="sidebar" /></SidebarFrame>;

});


export type PlatformSidebarAdapter = {
    children: React.ReactNode;
    onNew: () => void;
    onSettings: () => void;
    newLabel?: string;
    settingsLabel?: string;
    busy?: boolean;
};

/** Explicit account-backed mode never mounts the device sidebar controller. */
export const SidebarView = React.memo((props: { platform?: PlatformSidebarAdapter }) => props.platform
    ? <SidebarFrame {...props.platform} newLabel={props.platform.newLabel ?? t('sidebar.newSession')} settingsLabel={props.platform.settingsLabel ?? t('settings.title')} />
    : <DeviceSidebarView />);

/** One original Happy sidebar frame for device sessions and account-backed conversations. */
function SidebarFrame(props: PlatformSidebarAdapter & {
    newLabel: string; settingsLabel: string;
    shortcutHintsVisible?: boolean; archiveControl?: React.ReactNode; status?: React.ReactNode;
}) {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    return <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
        <View style={styles.topControls}>
            <Pressable accessibilityRole="button" accessibilityLabel={props.newLabel} onPress={props.onNew} disabled={props.busy}
                style={({ pressed }) => [styles.newSessionButton, props.shortcutHintsVisible && styles.shortcutTargetActive, pressed && styles.newSessionButtonPressed, props.busy && { opacity: 0.4 }]}>
                <Ionicons name="create-outline" size={16} color={styles.newSessionText.color} />
                <Text style={styles.newSessionText}>{props.newLabel}</Text>
                {props.shortcutHintsVisible !== undefined ? <ShortcutHintBadge shortcutKey="N" style={styles.shortcutBadgeInline} /> : null}
            </Pressable>
            {props.archiveControl}
        </View>
        {props.status}
        {props.children}
        <Pressable accessibilityRole="button" accessibilityLabel={props.settingsLabel} onPress={props.onSettings}
            style={[styles.settingsRow, props.shortcutHintsVisible && styles.shortcutTargetActive]}>
            <Ionicons name="settings-outline" size={18} color={styles.settingsText.color} />
            <Text style={styles.settingsText}>{props.settingsLabel}</Text>
            {props.shortcutHintsVisible !== undefined ? <ShortcutHintBadge shortcutKey="," style={styles.shortcutBadgeInline} /> : null}
        </Pressable>
    </View>;
}
