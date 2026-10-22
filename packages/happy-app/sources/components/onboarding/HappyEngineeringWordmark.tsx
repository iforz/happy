import * as React from 'react';
import { Image, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { usePageConfig } from '@/integrations/tokenhub/usePageConfig';
// Keep the internal export name for compatibility; display comes from TokenHub.
export const HappyEngineeringWordmark = React.memo(function WorkWordmark({ height }: { height: number }) {
 const { theme } = useUnistyles(); const { config } = usePageConfig();
 return config.logoUrl ? <Image source={{ uri: config.logoUrl }} style={{ height, width: height * 2, resizeMode: 'contain' }} accessibilityLabel={config.brandName} /> : <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: height * .65, fontWeight: '700' }}>{config.brandName}</Text>;
});
