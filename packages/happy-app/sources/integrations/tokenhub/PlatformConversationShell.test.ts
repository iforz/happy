import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const device = vi.hoisted(() => ({ width: 1200, tablet: true }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', surface: 'white', groupped: { background: 'gray' }, divider: 'gray' } } }) }));
vi.mock('@/components/navigation/Header', () => ({ Header: 'Header' }));
vi.mock('@/components/HeaderLogo', () => ({ HeaderLogo: 'HeaderLogo' }));
vi.mock('@/components/ChatHeaderView', () => ({ ChatHeaderView: 'ChatHeaderView' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => device.tablet, useLayoutDimensions: () => ({ width: device.width }) }));
import { PlatformConversationShell } from './PlatformConversationShell';
beforeEach(() => { device.width = 1200; device.tablet = true; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
async function render() { let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(PlatformConversationShell, { title: 'Hello', sidebar: (close: () => void) => React.createElement(Pressable, { onPress: close, testID: 'history' }), composer: React.createElement(Composer), newLabel: 'New', historyLabel: 'History', onNew: () => {}, busy: false, children: React.createElement(Messages) })); }); return tree!; }
const Pressable = 'Pressable' as any, Composer = 'Composer' as any, Messages = 'Messages' as any;
it('uses Happy headers, fixed sidebar sizing and a centered original composer', async () => {
 const tree = await render();
 expect(tree.root.findAllByType('Header' as any)).toHaveLength(1);
 expect(tree.root.findAllByType('ChatHeaderView' as any)).toHaveLength(1);
 expect(tree.root.findAllByType('View' as any).some((n: any) => n.props.style?.width === 360)).toBe(true);
 expect(tree.root.findByType(Composer).parent.props.style).toMatchObject({ maxWidth: 800, alignSelf: 'center' });
 await act(async () => tree.unmount());
});
it('collapses history on phones and closes it after selecting a conversation', async () => {
 device.width = 390; device.tablet = false; const tree = await render();
 expect(tree.root.findAllByProps({ testID: 'history' })).toHaveLength(0);
 await act(async () => tree.root.findByType('ChatHeaderView' as any).props.onBackPress());
 expect(tree.root.findAllByProps({ testID: 'history' })).toHaveLength(1);
 expect(tree.root.findAllByType(Composer)).toHaveLength(0);
 await act(async () => tree.root.findByProps({ testID: 'history' }).props.onPress());
 expect(tree.root.findAllByType(Composer)).toHaveLength(1);
 await act(async () => tree.unmount());
});
