import * as React from 'react';
// @ts-expect-error upstream does not install renderer types
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ status: 'ready', language: 'en', save: vi.fn(), sync: vi.fn() }));
vi.mock('./PlatformSessionProvider', () => ({ usePlatformSession: () => ({ status: state.status }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ applySettingsLocal: (patch: any) => { state.language = patch.preferredLanguage; state.save(patch); } }) }, useSettingMutable: () => [state.language, state.sync] }));
import { usePlatformPreference } from './platformPreferences';
let preference: ReturnType<typeof usePlatformPreference<'preferredLanguage'>>;
function Screen() { preference = usePlatformPreference('preferredLanguage'); return null; }
beforeEach(() => { state.status = 'ready'; state.language = 'en'; state.save.mockClear(); state.sync.mockClear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
it('persists platform preferences across remounts without queuing device sync', async () => {
 let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(Screen)); });
 await act(async () => preference[1]('zh-Hans')); await act(async () => tree.unmount());
 await act(async () => { tree = create(React.createElement(Screen)); });
 expect(preference[0]).toBe('zh-Hans'); expect(state.save).toHaveBeenCalledWith({ preferredLanguage: 'zh-Hans' }); expect(state.sync).not.toHaveBeenCalled(); await act(async () => tree.unmount());
});
it('retains existing device preference synchronization outside platform mode', async () => {
 state.status = 'disabled'; let tree: ReturnType<typeof create>; await act(async () => { tree = create(React.createElement(Screen)); });
 await act(async () => preference[1]('zh-Hans')); expect(state.sync).toHaveBeenCalledWith('zh-Hans'); expect(state.save).not.toHaveBeenCalled(); await act(async () => tree.unmount());
});
