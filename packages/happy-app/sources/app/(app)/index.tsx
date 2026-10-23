import { getServerUrl } from '@/sync/serverConfig';
import { accountScope, TokenHubConversation } from '@/integrations/tokenhub/TokenHubConversation';
import { isTokenHubSessionForUI } from '@/integrations/tokenhub/sessionSource';
import { TokenHubWelcome } from "@/integrations/tokenhub/TokenHubWelcome";
import { useAuth } from "@/auth/AuthContext";
import { Platform } from "react-native";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useRouter } from "expo-router";
import { getRandomBytesAsync } from "expo-crypto";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { MainView } from "@/components/MainView";
import { OnboardingLinkComputer } from "@/components/onboarding/LinkComputer";
import { shouldShowFirstRunInstall } from "@/components/onboarding/firstRunOnboarding";
import { useAllMachines, useIsDataReady } from "@/sync/storage";
import { isRunningOnMac } from '@/utils/platform';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    if (auth.credentials && isTokenHubSessionForUI(auth.credentials.token)) return <TokenHubConversation key={accountScope(getServerUrl(),auth.credentials.token)} />;
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    // Until a computer is linked there is nothing for the home chrome to do:
    // the dock, filters, session list, and tablet sidebar all need a machine.
    // Native phones and tablets therefore share the same link screen. Web
    // and desktop retain their existing account-linking flow.
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: true,
        isDataReady,
        machineCount: machines.length,
        isWeb: Platform.OS === 'web',
        isRunningOnMac: isRunningOnMac(),
    });
    if (showInstallStep) {
        return <OnboardingLinkComputer />;
    }
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            console.error('Error creating account', error);
        }
    }

    const openRestore = () => {
        trackAccountRestored();
        router.push('/restore');
    };

    return <TokenHubWelcome restore={openRestore} create={createAccount} />;

}
