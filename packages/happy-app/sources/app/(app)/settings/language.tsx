import { usePlatformSession } from '@/integrations/tokenhub/PlatformSessionProvider';
import { workText } from '@/integrations/tokenhub/workText';
import { resolveLanguageTag } from '@/text/_all';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { usePlatformPreference } from '@/integrations/tokenhub/platformPreferences';
import { useUnistyles } from 'react-native-unistyles';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from '@/text';
import { Modal } from '@/modal';
import { useUpdates } from '@/hooks/useUpdates';
import * as Localization from 'expo-localization';

type LanguageOption = 'auto' | SupportedLanguage;

interface LanguageItem {
    key: LanguageOption;
    title: string;
    subtitle?: string;
}

export default function LanguageSettingsScreen() {
    const platform = usePlatformSession();
    const { theme } = useUnistyles();
    const [preferredLanguage, setPreferredLanguage] = usePlatformPreference('preferredLanguage');
    const { reloadApp } = useUpdates();

    // Get device locale for automatic detection
    const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
    const deviceLanguage = resolveLanguageTag(deviceLocale);
    const detectedLanguageName = getLanguageNativeName(deviceLanguage);

    // Current selection
    const currentSelection: LanguageOption = preferredLanguage === null ? 'auto' : 
                                           SUPPORTED_LANGUAGE_CODES.includes(preferredLanguage as SupportedLanguage) ? 
                                           preferredLanguage as SupportedLanguage : 'auto';

    // Language options - dynamically generated from supported languages
    const languageOptions: LanguageItem[] = [
        {
            key: 'auto',
            title: t('settingsLanguage.automatic'),
            subtitle: `${t('settingsLanguage.automaticSubtitle')} (${detectedLanguageName})`
        },
        ...SUPPORTED_LANGUAGE_CODES.map(code => ({
            key: code,
            title: getLanguageNativeName(code)
        }))
    ];

    const handleLanguageChange = async (newLanguage: LanguageOption) => {
        if (newLanguage === currentSelection) {
            return; // No change
        }

        // Show confirmation modal
        const confirmed = await Modal.confirm(
            t('settingsLanguage.needsRestart'),
            t('settingsLanguage.needsRestartMessage')
        );

        if (confirmed) {
            // Update the preference
            const newPreference = newLanguage === 'auto' ? null : newLanguage;
            setPreferredLanguage(newPreference);

            // Small delay to ensure setting is saved
            setTimeout(() => {
                reloadApp();
            }, 100);
        }
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup 
                title={t('settingsLanguage.currentLanguage')} 
                footer={platform.status !== 'disabled' ? workText('localPreferenceDescription') : t('settingsLanguage.description')}
            >
                {languageOptions.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons 
                            name="language-outline" 
                            size={29} 
                            color="#007AFF" 
                        />}
                        rightElement={
                            currentSelection === option.key ? (
                                <Ionicons 
                                    name="checkmark" 
                                    size={20} 
                                    color="#007AFF" 
                                />
                            ) : null
                        }
                        onPress={() => handleLanguageChange(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}