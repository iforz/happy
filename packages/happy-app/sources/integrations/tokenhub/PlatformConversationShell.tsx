import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { AgentContentView } from '@/components/AgentContentView';
import { useSidebarActions } from '@/components/SidebarNavigator';
import { layout } from '@/components/layout';

type Props = {
    title: string; sidebar?: (close: () => void) => React.ReactNode; children: React.ReactNode; composer: React.ReactNode;
    actions?: React.ReactNode; newLabel: string; historyLabel: string; onNew: () => void; busy: boolean;
};
/** Only adapts account content to Happy's original chat header/content components. Navigation belongs to the shared root layout. */
export function PlatformConversationShell(props: Props) {
    const { theme } = useUnistyles();
    const sidebar = useSidebarActions();
    return <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface }}>
        <ChatHeaderView title={props.title} rightSlot={<View style={{ flexDirection: 'row' }}>
            {props.actions}
            {!sidebar.isDesktop ? <Pressable accessibilityRole="button" accessibilityLabel={props.historyLabel} onPress={sidebar.open} style={{ padding: 12 }}><Ionicons name="menu-outline" size={24} color={theme.colors.text} /></Pressable> : null}
        </View>} />
        <AgentContentView content={props.children} input={<View style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', paddingHorizontal: 12, paddingBottom: 12 }}>{props.composer}</View>} />
    </View>;
}
