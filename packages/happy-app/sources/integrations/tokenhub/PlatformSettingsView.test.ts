import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ session: { authority: 'https://token.example.test', subject: '42' } as any, status: 'ready', open: vi.fn(), push: vi.fn(), logout: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: f.push, replace: f.push }) }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/onboarding/HappyEngineeringWordmark', () => ({ HappyEngineeringWordmark: 'Wordmark' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: f.open }));
vi.mock('./PlatformWelcome', () => ({ PlatformWelcome: 'PlatformWelcome' }));
vi.mock('./PlatformSessionProvider', () => ({ usePlatformSession: () => ({ session: f.session, status: f.status, logout: f.logout }) }));
import { PlatformSettingsView, platformAccountURL } from './PlatformSettingsView';
beforeEach(() => { f.session = { authority: 'https://token.example.test', subject: '42' }; f.open.mockClear(); f.push.mockClear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
it('uses native rows and real account links without device-only actions', async () => {
 let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(PlatformSettingsView)); });
 const rows = tree.root.findAllByType('Item' as any);
 expect(rows.map((row: any) => row.props.title)).toEqual(['settings.account', 'Subscription center', 'My subscriptions', 'settings.appearance', 'settingsLanguage.currentLanguage', 'Sign out of Work']);
 await act(async () => rows[0].props.onPress()); await act(async () => rows[1].props.onPress()); await act(async () => rows[2].props.onPress());
 expect(f.open.mock.calls.map(([url]) => url)).toEqual(['https://token.example.test/profile', 'https://token.example.test/purchase', 'https://token.example.test/subscriptions']);
 await act(async () => rows[3].props.onPress()); expect(f.push).toHaveBeenCalledWith('/settings/appearance'); expect(f.session.subject).toBe('42'); await act(async () => tree.unmount());
});
it('keeps account operations unavailable without a cookie session', async () => {
 f.session = null; let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(PlatformSettingsView)); });
 expect(tree.root.findAllByType('Item' as any)).toHaveLength(0); expect(tree.root.findAllByType('PlatformWelcome' as any)).toHaveLength(1); await act(async () => tree.unmount());
});
it('keeps links on the authenticated authority and rejects unsafe origins', () => {
 expect(platformAccountURL('https://token.example.test/path?x=y', 'profile')).toBe('https://token.example.test/profile');
 for (const authority of ['javascript:alert(1)', 'https://user:secret@token.example.test', 'http://token.example.test']) expect(() => platformAccountURL(authority, 'profile')).toThrow();
});
