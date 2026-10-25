import * as React from 'react';
import { storage, useSettingMutable } from '@/sync/storage';
import type { Settings } from '@/sync/settings';
import { usePlatformSession } from './PlatformSessionProvider';

// Display/composer preferences are safe without a device signing identity.
export const platformPreferenceKeys = [
    'showLineNumbersInToolViews', 'alwaysShowContextSize', 'showFlavorIcons',
    'showHarnessIconInSessionHeader', 'compactToolCalls', 'userMessageBubbleColor',
    'usageLimitShowRemaining', 'preferredLanguage', 'avatarStyle', 'avatarMonochrome',
    'sessionListGrouping', 'agentInputEnterToSend', 'fileDiffsSidebar', 'groupToolCalls',
] as const satisfies readonly (keyof Settings)[];
type Preference = typeof platformPreferenceKeys[number];
export function usePlatformPreference<K extends Preference>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const platform = usePlatformSession();
    const [value, setDeviceValue] = useSettingMutable(name);
    const setValue = React.useCallback((next: Settings[K]) => {
        if (platform.status !== 'disabled') storage.getState().applySettingsLocal({ [name]: next });
        else setDeviceValue(next);
    }, [name, platform.status, setDeviceValue]);
    return [value, setValue];
}
