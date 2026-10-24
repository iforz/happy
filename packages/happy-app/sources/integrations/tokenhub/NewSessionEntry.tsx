import * as React from 'react';
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useAuth } from '@/auth/AuthContext';
import { isTokenHubSessionForUI } from './sessionSource';
import { usePlatformSession } from './PlatformSessionProvider';

/** Reuse Home's sole conversation owner; a stacked second writer can lose history. */
export function NewSessionEntry({ children }: { children: React.ReactNode }) {
    const auth = useAuth();
    const router = useRouter();
    const { mode } = useLocalSearchParams<{ mode?: string }>();
    const platform = usePlatformSession();
    const platformMode = platform.status !== 'disabled' && mode !== 'device';
    const tokenHub = platformMode ? platform.status === 'ready' && !!platform.session
        : auth.isAuthenticated && mode !== 'device' && !!auth.credentials && isTokenHubSessionForUI(auth.credentials.token);
    const dispatched = React.useRef(false);
    useFocusEffect(React.useCallback(() => {
        if (tokenHub && !dispatched.current) {
            dispatched.current = true;
            // POP_TO reuses an existing Home; replace/Redirect could stack another one.
            router.dismissTo({ pathname: '/', params: { newChat: randomUUID() } });
        }
    }, [router, tokenHub]));
    if (platformMode && !tokenHub || !platformMode && !auth.isAuthenticated) return <Redirect href="/" />;
    if (tokenHub) return null;
    // Device-agent entry is deliberate; it does not advertise TokenHub model availability.
    return <>{children}</>;
}
