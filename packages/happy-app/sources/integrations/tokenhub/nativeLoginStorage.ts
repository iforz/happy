import * as SecureStore from 'expo-secure-store';

// SecureStore key names cannot contain ':'. Never put these values in AsyncStorage or a URL.
const FLOW = 'happy.tokenhub.native.flow.v1';
const IDENTITY = 'happy.tokenhub.native.identity.v1';
const SESSION = 'happy.tokenhub.native.session.v1';
export interface NativeLoginFlow { server: string; state: string; binding: string; proof: string; secret: string; expiresAt: number }
export interface NativeSession { server: string; token: string; expiresAt: number | null }
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const nativeLoginStorage = {
    async flow(): Promise<NativeLoginFlow | null> {
        const value = await SecureStore.getItemAsync(FLOW);
        if (!value) return null;
        try { return JSON.parse(value); } catch { await SecureStore.deleteItemAsync(FLOW); return null; }
    },
    saveFlow: (flow: NativeLoginFlow) => SecureStore.setItemAsync(FLOW, JSON.stringify(flow), options),
    clearFlow: () => SecureStore.deleteItemAsync(FLOW),
    identity: () => SecureStore.getItemAsync(IDENTITY),
    // The encryption identity is not an authorization token. Preserve it through expiry/relogin.
    saveIdentity: (secret: string) => SecureStore.setItemAsync(IDENTITY, secret, options),
    async session(): Promise<NativeSession | null> {
        const value = await SecureStore.getItemAsync(SESSION);
        if (!value) return null;
        try { return JSON.parse(value); } catch { await SecureStore.deleteItemAsync(SESSION); return null; }
    },
    saveSession: (session: NativeSession) => SecureStore.setItemAsync(SESSION, JSON.stringify(session), options),
    clearSession: () => SecureStore.deleteItemAsync(SESSION),
};
