import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const sidebar = vi.hoisted(() => ({ isDesktop: true, open: vi.fn(), close: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', surface: 'white' } } }) }));
vi.mock('@/components/SidebarNavigator', () => ({ useSidebarActions: () => sidebar }));
vi.mock('@/components/ChatHeaderView', async () => { const R = await import('react'); return { ChatHeaderView: (props: any) => R.createElement('ChatHeaderView', props, props.rightSlot) }; });
vi.mock('@/components/AgentContentView', async () => { const R = await import('react'); return { AgentContentView: (props: any) => R.createElement('AgentContentView', props, props.content, props.input) }; });
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
import { PlatformConversationShell } from './PlatformConversationShell';
beforeEach(() => { sidebar.isDesktop = true; sidebar.open.mockClear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
const Composer = 'Composer' as any, Messages = 'Messages' as any;
async function render() { let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(PlatformConversationShell, { title: 'Hello', composer: React.createElement(Composer), newLabel: 'New', historyLabel: 'History', onNew: () => {}, busy: false, children: React.createElement(Messages) })); }); return tree!; }
it('uses the actual Happy content/header and leaves all sidebar layout to the native root navigator', async () => {
 const tree = await render();
 expect(tree.root.findAllByType('ChatHeaderView' as any)).toHaveLength(1);
 expect(tree.root.findAllByType('AgentContentView' as any)).toHaveLength(1);
 expect(tree.root.findAllByType(Composer)).toHaveLength(1);
 expect(tree.root.findAllByType(Messages)).toHaveLength(1);
 expect(tree.root.findByType(Composer).parent.props.style).toMatchObject({ maxWidth: 800, alignSelf: 'center' });
 expect(tree.root.findAllByType('Pressable' as any)).toHaveLength(0);
 await act(async () => tree.unmount());
});
it('opens the shared native drawer on phones without replacing or unmounting the composer', async () => {
 sidebar.isDesktop = false; const tree = await render(); const composer = tree.root.findByType(Composer);
 await act(async () => tree.root.findByProps({ accessibilityLabel: 'History' }).props.onPress());
 expect(sidebar.open).toHaveBeenCalledOnce(); expect(tree.root.findByType(Composer)).toBe(composer);
 await act(async () => tree.unmount());
});
