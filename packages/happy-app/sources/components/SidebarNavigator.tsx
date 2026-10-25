import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight, useLayoutDimensions } from '@/utils/responsive';
import { SidebarView, type PlatformSidebarAdapter } from './SidebarView';
import { Drawer as DrawerLayout } from 'react-native-drawer-layout';
import { View, Pressable, Platform } from 'react-native';
import { useAllMachines, useIsDataReady, useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';
import { canRouteForward, canUseRouteBack, getNavigatorCanGoBack } from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { isRunningOnMac } from '@/utils/platform';
import { shouldShowFirstRunInstall, shouldSuppressTabletShell } from './onboarding/firstRunOnboarding';

const TAURI_HEADER_CONTROL_LEFT = Math.ceil(92 / DEFAULT_APP_ZOOM);

const DeviceSidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    const pathname = usePathname();
    const zenMode = useLocalSetting('zenMode');
    const isWeb = Platform.OS === 'web';
    const runningOnMac = isRunningOnMac();
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: auth.isAuthenticated,
        isDataReady,
        machineCount: machines.length,
        isWeb,
        isRunningOnMac: runningOnMac,
    });
    // The onboarding screen owns the whole native canvas. Keep the permanent
    // tablet sidebar and its header out of steps 2 and 3, including the brief
    // interval after a scanned machine arrives but before the route dismisses.
    const suppressTabletShell = shouldSuppressTabletShell({
        isAuthenticated: auth.isAuthenticated,
        isTablet,
        showInstallStep,
        isOnboardingRoute: pathname.startsWith('/onboarding/'),
        isWeb,
        isRunningOnMac: runningOnMac,
    });
    const isDesktopLayout = auth.isAuthenticated && isTablet && !suppressTabletShell;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useLayoutDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return 280;
        return sidebarDrawerWidth(windowWidth);
    }, [windowWidth, isDesktopLayout]);
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;

    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Non-tablet: use front drawer, hidden
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        // Tablet: always permanent, just collapse width in zen mode.
        //
        // We deliberately do NOT animate `width` on web. A CSS transition on
        // the drawer width re-flowed the chat flex-1 sibling on every frame,
        // re-measuring the entire FlatList tree at ~15fps. Snapping the
        // width change makes the chat reflow exactly once. Native already
        // snaps because RN doesn't honor CSS transition properties.
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth]);

    const drawerContent = React.useCallback(
        () => <SidebarView />,
        []
    );

    return (
        <SidebarNavigatorSurface>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={isDesktopLayout ? drawerContent : undefined}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && (
                <PersistentHeader />
            )}
        </SidebarNavigatorSurface>
    );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
    const router = useRouter();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');

    const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
    const canGoForward = useBrowserNavigationStore((s) => s.routeHistory ? canRouteForward(s.routeHistory) : false);
    const overlayCanBack = useOverlayNav((s) => s.canBack);
    const overlayCanForward = useOverlayNav((s) => s.canForward);
    const canGoBack = routeHistory
        ? canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
        : false;

    const handleZenToggle = React.useCallback(() => {
        setZenMode(!zenMode);
    }, [zenMode, setZenMode]);

    const handleBack = React.useCallback(() => {
        // Intra-session overlay (file diff / file view) consumes back first,
        // so the chat → diff → file flow can be unwound without a close X.
        if (useOverlayNav.getState().back()) return;
        const nav = useBrowserNavigationStore.getState();
        if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router))) return;
        nav.markRouteBack();
        router.back();
    }, [router]);

    const handleForward = React.useCallback(() => {
        if (useOverlayNav.getState().forward()) return;
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            const nav = useBrowserNavigationStore.getState();
            if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
            nav.markRouteForward();
            window.history.forward();
        }
    }, []);

    const canGoBackEffective = canGoBack || overlayCanBack;
    const canGoForwardEffective = canGoForward || overlayCanForward;

    return <PersistentHeaderView zenMode={zenMode} onZenToggle={handleZenToggle} onBack={handleBack} onForward={handleForward} canGoBack={canGoBackEffective} canGoForward={canGoForwardEffective} />;
});

/** Shared original desktop chrome: account mode supplies actions without device sync. */
function PersistentHeaderView(props: {
    zenMode: boolean; onZenToggle: () => void; onBack: () => void; onForward: () => void;
    canGoBack: boolean; canGoForward: boolean;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    return (
        <View
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingTop: safeArea.top,
                paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
                paddingRight: 16,
                height: safeArea.top + headerHeight,
                flexDirection: 'row',
                alignItems: 'center',
                zIndex: 1100,
            }}
            pointerEvents="box-none"
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {/* Zen / Back / Forward buttons */}
            <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                pointerEvents="auto"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                <Pressable
                    onPress={props.onZenToggle}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel={t('zen.toggle')}
                >
                    <Image
                        source={require('@/assets/images/zen-icon.png')}
                        contentFit="contain"
                        style={{ width: 18, height: 18 }}
                        tintColor={props.zenMode ? theme.colors.textLink : theme.colors.header.tint}
                    />
                </Pressable>
                <Pressable onPress={props.onBack} disabled={!props.canGoBack} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: props.canGoBack ? 1 : 0.3 }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                </Pressable>
                {Platform.OS === 'web' && (
                    <Pressable onPress={props.onForward} disabled={!props.canGoForward} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: props.canGoForward ? 1 : 0.3 }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            </View>
        </View>
    );
}

export function sidebarDrawerWidth(windowWidth: number): number {
    return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
}

function SidebarNavigatorSurface({ children }: { children: React.ReactNode }) {
    return <View style={{ flex: 1 }}>{children}</View>;
}

export type PlatformNavigatorAdapter = {
    sidebar: PlatformSidebarAdapter;
    children: React.ReactNode;
    onBack?: () => void;
    canGoBack?: boolean;
    onForward?: () => void;
    canGoForward?: boolean;
};
const SidebarActions = React.createContext({ isDesktop: false, open: () => {}, close: () => {} });
export const useSidebarActions = () => React.useContext(SidebarActions);

/** The same drawer engine and original sidebar/header presentation, with an explicit account data port. */
function PlatformSidebarNavigator({ adapter }: { adapter: PlatformNavigatorAdapter }) {
    const isDesktop = useIsTablet();
    const { width } = useLayoutDimensions();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    const actions = React.useMemo(() => ({ isDesktop, open: () => setOpen(true), close }), [isDesktop, close]);
    const sidebar = { ...adapter.sidebar, onNew: () => { close(); adapter.sidebar.onNew(); }, onSettings: () => { close(); adapter.sidebar.onSettings(); } };
    return <SidebarActions.Provider value={actions}><SidebarNavigatorSurface>
        <DrawerLayout open={isDesktop ? !zenMode : open} onOpen={() => setOpen(true)} onClose={close}
            drawerType={isDesktop ? 'permanent' : 'front'} drawerPosition="left" swipeEnabled={false}
            drawerStyle={{ backgroundColor: 'white', borderRightWidth: 0, width: isDesktop ? (zenMode ? 0 : sidebarDrawerWidth(width)) : 280, overflow: 'hidden' }}
            renderDrawerContent={() => <SidebarView platform={sidebar} />}>
            {adapter.children}
        </DrawerLayout>
        {isDesktop ? <PersistentHeaderView zenMode={zenMode} onZenToggle={() => setZenMode(!zenMode)} onBack={adapter.onBack ?? (() => {})} onForward={adapter.onForward ?? (() => {})} canGoBack={!!adapter.canGoBack} canGoForward={!!adapter.canGoForward} /> : null}
    </SidebarNavigatorSurface></SidebarActions.Provider>;
}

export const SidebarNavigator = React.memo((props: { platform?: PlatformNavigatorAdapter }) => props.platform
    ? <PlatformSidebarNavigator adapter={props.platform} />
    : <DeviceSidebarNavigator />);
