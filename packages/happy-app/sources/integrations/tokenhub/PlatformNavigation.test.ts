import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const nav = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn(), back: vi.fn(), close: vi.fn(), pathname: '/' }));
vi.mock('expo-router', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ ...nav, canGoBack: () => true }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-intent' }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray' } } }) }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/components/SidebarNavigator', async () => { const R = await import('react'); return { useSidebarActions: () => ({ close: nav.close }), SidebarNavigator: (props: any) => R.createElement('NativeNavigator', props.platform, props.platform.sidebar.children, props.platform.children) }; });
vi.mock('@/components/FlatSessionRow', () => ({ FlatSessionRowView: 'NativeSessionRow' }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/utils/sessionListTimestamp', () => ({ formatSessionListTimestamp: (value: number) => `time:${value}` }));
import { PlatformNavigationLayout, PlatformNavigationProvider, usePlatformNavigationRegistration, type PlatformNavigationSnapshot } from './PlatformNavigation';
function Home({ snapshot }: { snapshot: PlatformNavigationSnapshot }) { usePlatformNavigationRegistration(snapshot); return React.createElement('Home'); }
function App({ scope = 'account-a', home = true, snapshot }: { scope?: string; home?: boolean; snapshot: PlatformNavigationSnapshot }) { return React.createElement(PlatformNavigationProvider, { scope, children: React.createElement(PlatformNavigationLayout, { children: home ? React.createElement(Home, { snapshot }) : React.createElement('Settings') }) }); }
beforeEach(() => { nav.navigate.mockClear(); nav.push.mockClear(); nav.close.mockClear(); nav.pathname = '/'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
it('keeps only account summaries across settings and navigates history/new/settings through real routes', async () => {
 const snapshot = { items: [{ id: 'real-id', title: 'A saved chat', updatedAt: 100, model: 'allowed-model', csrf: 'never-cache', turns: ['private body'] }], selectedId: 'real-id' };
 let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(App, { snapshot })); });
 const row = () => tree.root.findByType('NativeSessionRow' as any);
 expect(row().props).toMatchObject({ title: 'A saved chat', selected: true, projectName: 'allowed-model' });
 const { avatar, onPressProps, ...presentation } = row().props;
 expect(JSON.stringify(presentation)).not.toContain('never-cache'); expect(JSON.stringify(presentation)).not.toContain('private body');
 await act(async () => tree.update(React.createElement(App, { home: false, snapshot })));
 expect(row().props.title).toBe('A saved chat');
 await act(async () => row().props.onPressProps.onPress());
 expect(nav.navigate).toHaveBeenLastCalledWith({ pathname: '/', params: { conversationId: 'real-id' } }); expect(nav.close).toHaveBeenCalledOnce();
 const sidebar = tree.root.findByType('NativeNavigator' as any).props.sidebar;
 await act(async () => sidebar.onNew()); expect(nav.navigate).toHaveBeenLastCalledWith({ pathname: '/', params: { newChat: 'new-intent' } });
 await act(async () => sidebar.onSettings()); expect(nav.push).toHaveBeenLastCalledWith('/settings');
 await act(async () => tree.update(React.createElement(App, { scope: 'account-b', home: false, snapshot })));
 expect(tree.root.findAllByType('NativeSessionRow' as any)).toHaveLength(0);
 await act(async () => tree.unmount());
});
