import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ restartRequired: false, cleanupRequired: false, logout: vi.fn(), begin: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', Linking: { openURL: vi.fn() } }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { groupped: { background: 'white' }, text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('@/components/RoundButton', async () => { const R = await import('react'); return { RoundButton: (props: any) => R.createElement('RoundButton', props) }; });
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ restartRequired: fixture.restartRequired, cleanupRequired: fixture.cleanupRequired, logout: fixture.logout, login: vi.fn() }) }));
vi.mock('./usePageConfig', () => ({ usePageConfig: () => ({ config: { showLogin: true, ssoReady: true, showLocalLogin: true, loginLabel: '统一登录' }, offline: false }) }));
vi.mock('./login', () => ({ beginTokenHubLogin: fixture.begin, saveTokenHubLogin: vi.fn() }));
vi.mock('./logoutNotice', () => ({ readSessionNotice: async () => '本机已退出，远端撤销未确认。' }));
import { TokenHubWelcome } from './TokenHubWelcome';
let renderer: ReturnType<typeof create>;
beforeEach(() => { fixture.restartRequired = false; fixture.cleanupRequired = false; fixture.logout.mockClear(); fixture.begin.mockClear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.unstubAllGlobals(); });
it('shows the manual restart requirement, preserves remote uncertainty, and removes all new-login actions', async () => {
    const restore = vi.fn(), makeIdentity = vi.fn(async () => {});
    const screen = () => React.createElement(TokenHubWelcome, { restore, create: makeIdentity });
    await act(async () => { renderer = create(screen()); });
    expect(renderer.root.findAllByType('RoundButton')).toHaveLength(2);
    await act(async () => { fixture.restartRequired = true; renderer.update(screen()); });
    expect(renderer.root.findAllByType('RoundButton')).toHaveLength(0);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('完全关闭并重新打开 App');
    expect(JSON.stringify(renderer.toJSON())).toContain('远端撤销未确认');
    expect(fixture.begin).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(makeIdentity).not.toHaveBeenCalled();
});

it('exposes only retry cleanup when secure deletion failed, never falsely saying credentials have been cleared', async () => {
    fixture.cleanupRequired = true;
    await act(async () => { renderer = create(React.createElement(TokenHubWelcome, { restore: vi.fn(), create: vi.fn() })); });
    const buttons = renderer.root.findAllByType('RoundButton'); expect(buttons).toHaveLength(1);
    expect(buttons[0].props.title).toBe('重试本机退出清理');
    const content = JSON.stringify(renderer.toJSON()); expect(content).toContain('本机凭据尚未清除');
    expect(content).not.toContain('本机授权已清除');
    await act(async () => { await buttons[0].props.action(); }); expect(fixture.logout).toHaveBeenCalledOnce();
    expect(fixture.begin).not.toHaveBeenCalled();
});
