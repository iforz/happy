import * as React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { accountScope, TokenHubConversation } from './TokenHubConversation';
import { isTokenHubSessionForUI } from './sessionSource';

/** /new must use the same account-model path as TokenHub Home, not a CLI fallback. */
export function NewSessionEntry({ children }: { children: React.ReactNode }) {
    const auth = useAuth();
    const { mode } = useLocalSearchParams<{ mode?: string }>();
    if (!auth.isAuthenticated) return <Redirect href="/" />;
    if (mode !== 'device' && auth.credentials && isTokenHubSessionForUI(auth.credentials.token)) {
        return <TokenHubConversation key={accountScope(getServerUrl(), auth.credentials.token)} startNew />;
    }
    // Device-agent entry is deliberate; it does not advertise TokenHub model availability.
    return <>{children}</>;
}
