import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__DEV__', false); });
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'), TouchableWithoutFeedback: host('TouchableWithoutFeedback'), Platform: { OS: 'web', select: (values: any) => values.web ?? values.default }, Keyboard: { isVisible: () => false, addListener: () => ({ remove() {} }), dismiss() {} } };
});
vi.mock('react-native-unistyles', () => {
    const color: any = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => '#000' : color });
    const theme = { dark: false, colors: color };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), absoluteFillObject: {} } };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSetting: () => true }));
vi.mock('@/sync/modeHacks', () => ({ hackMode: (mode: any) => mode, hackModes: (modes: any) => modes }));
vi.mock('@/sync/rig', () => ({ isRigMetadata: () => false }));
vi.mock('@/utils/responsive', () => ({ useLayoutDimensions: () => ({ width: 1200, height: 800 }) }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: vi.fn() }));
vi.mock('@/utils/permissionModeLabels', () => ({ getPermissionModeMenuLabel: () => '', getPermissionModeShortLabel: () => '' }));
vi.mock('@/utils/sessionStatusBar', () => ({ getUsageLimitRows: () => [], getUsageLimitDisplayPercentage: () => 0, formatUsageLimitResetTime: () => '' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn(), hapticsError: vi.fn() }));
vi.mock('./MultiTextInput', () => ({ MultiTextInput: 'MultiTextInput' }));
vi.mock('./AgentInputAttachmentStrip', () => ({ AgentInputAttachmentStrip: 'AgentInputAttachmentStrip' }));
vi.mock('./Shaker', () => ({ Shaker: 'Shaker' }));
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('./autocomplete/useActiveWord', () => ({ useActiveWord: () => null }));
vi.mock('./autocomplete/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn()] }));
vi.mock('./AgentInputAutocomplete', () => ({ AgentInputAutocomplete: 'AgentInputAutocomplete' }));
vi.mock('./FloatingOverlay', () => ({ FloatingOverlay: 'FloatingOverlay' }));
vi.mock('./MobileGlass', () => ({ MobileGlassSurface: 'MobileGlassSurface' }));
vi.mock('./AnimatedOverlay', () => ({ AnimatedFade: 'AnimatedFade' }));
vi.mock('./BubblePressable', () => ({ BubblePressable: 'BubblePressable' }));
vi.mock('./NativeSettingsMenu', () => ({ NativeSettingsMenu: 'NativeSettingsMenu' }));
vi.mock('./ProviderIcon', () => ({ ProviderIcon: 'ProviderIcon' }));
vi.mock('./PickerSheet', () => ({ PickerSheet: 'PickerSheet', PickerSheetOption: 'PickerSheetOption', PickerSheetSection: 'PickerSheetSection' }));
vi.mock('./glassInteractionPolicy', () => ({ shouldUseExpoNativeSettingsMenu: () => false }));
vi.mock('./modelModeOptions', () => ({ groupModelModesByProvider: (models: any[]) => [{ key: 'models', title: '', models }], truncateModelLabel: (label: string) => label }));
import { AgentInput } from './AgentInput';
const renderers: ReturnType<typeof create>[] = [];
const models = [{ key: 'flash', name: 'DeepSeek Flash' }, { key: 'pro', name: 'DeepSeek Pro' }];
function render(extra: Record<string, unknown> = {}) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(AgentInput, { initialValue: 'hello', placeholder: 'Message', onSend: vi.fn(), autocompletePrefixes: [], autocompleteSuggestions: async () => [], zenMode: true, modelMode: models[0], availableModels: models, onModelModeChange: vi.fn(), ...extra })); });
    renderers.push(renderer); return renderer;
}
function triggers(renderer: ReturnType<typeof create>) { return renderer.root.findAllByType('BubblePressable').filter((node: any) => node.props.accessibilityLabel === 'agentInput.model.title'); }
afterEach(() => act(() => renderers.splice(0).forEach(renderer => renderer.unmount())));
describe('AgentInput account model picker', () => {
    it('opens on web without a device permission callback and selects an authorized model', () => {
        const onModelModeChange = vi.fn(); const renderer = render({ modelPickerOnly: true, onModelModeChange });
        expect(triggers(renderer)).toHaveLength(1); expect(triggers(renderer)[0].props.disabled).toBe(false);
        act(() => triggers(renderer)[0].props.onPress());
        expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
        const option = renderer.root.findAllByType('PickerSheetOption').find((node: any) => node.props.label === 'DeepSeek Pro');
        expect(option).toBeDefined(); act(() => option!.props.onPress());
        expect(onModelModeChange).toHaveBeenCalledWith(models[1]); expect(renderer.root.findAllByType('PickerSheet')).toHaveLength(0);
    });
    it('allows opening the single authorized model', () => {
        const renderer = render({ modelPickerOnly: true, availableModels: [models[0]] });
        expect(triggers(renderer)[0].props.disabled).toBe(false); act(() => triggers(renderer)[0].props.onPress());
        expect(renderer.root.findAllByType('PickerSheetOption')).toHaveLength(1);
    });
    it('does not add the account entry to default zen mode', () => { expect(triggers(render())).toHaveLength(0); });
    it('keeps sending disabled while the model can still be inspected', () => {
        const onSend = vi.fn(); const renderer = render({ modelPickerOnly: true, isSendDisabled: true, onSend });
        act(() => renderer.root.findByType('MultiTextInput').props.onKeyPress({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }));
        expect(onSend).not.toHaveBeenCalled(); expect(triggers(renderer)[0].props.disabled).toBe(false);
        const sendButton = renderer.root.findAllByType('Pressable').find((node: any) => node.props.hitSlop?.bottom === 10);
        expect(sendButton).toBeDefined(); expect(sendButton!.props.disabled).toBe(true);
        act(() => sendButton!.props.onPress());
        expect(onSend).not.toHaveBeenCalled();
    });
});
