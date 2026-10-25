import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Header } from '@/components/navigation/Header';
import { HeaderLogo } from '@/components/HeaderLogo';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { layout } from '@/components/layout';
import { useIsTablet, useLayoutDimensions } from '@/utils/responsive';

type Props = {
    title: string; sidebar: (close: () => void) => React.ReactNode; children: React.ReactNode; composer: React.ReactNode;
    actions?: React.ReactNode; newLabel: string; historyLabel: string; onNew: () => void; busy: boolean;
};
/** Happy's layout with account-backed data; deliberately does not mount device sync. */
export function PlatformConversationShell(props: Props) {
    const { theme } = useUnistyles();
    const { width } = useLayoutDimensions();
    const tablet = useIsTablet();
    const wide = tablet && width >= 768;
    const [open, setOpen] = React.useState(false);
    const action = (name: 'create-outline' | 'menu-outline' | 'close-outline', label: string, onPress: () => void, disabled = false) =>
        <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ padding: 12, opacity: disabled ? 0.4 : 1 }}><Ionicons name={name} size={24} color={theme.colors.text} /></Pressable>;
    return <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', backgroundColor: theme.colors.surface }}>
        {wide || open ? <View style={{ width: wide ? Math.min(360, Math.max(250, Math.floor(width * 0.3))) : '100%', backgroundColor: theme.colors.groupped.background, borderRightWidth: wide ? 1 : 0, borderRightColor: theme.colors.divider, minHeight: 0 }}>
            <Header title={<HeaderLogo />} headerRight={() => <View style={{ flexDirection: 'row' }}>{action('create-outline', props.newLabel, () => { props.onNew(); setOpen(false); }, props.busy)}{!wide ? action('close-outline', props.historyLabel, () => setOpen(false)) : null}</View>} />
            <View style={{ flex: 1, minHeight: 0 }}>{props.sidebar(() => setOpen(false))}</View>
        </View> : null}
        {wide || !open ? <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <ChatHeaderView title={props.title} onBackPress={!wide ? () => setOpen(true) : undefined} rightSlot={<View style={{ flexDirection: 'row' }}>{props.actions}{!wide ? action('menu-outline', props.historyLabel, () => setOpen(true)) : null}{action('create-outline', props.newLabel, props.onNew, props.busy)}</View>} />
            <View style={{ flex: 1, minHeight: 0 }}>{props.children}</View>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', paddingHorizontal: 12, paddingBottom: 12 }}>{props.composer}</View>
        </View> : null}
    </View>;
}
