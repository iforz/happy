import { getRandomBytes } from 'expo-crypto';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';

/** Browser-only data encryption, never a login credential or a server identity. */
export function platformHistoryKey(scope: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): string | null {
    const key = 'tokenhub-platform-history-key:v1:' + scope;
    try {
        storage ??= localStorage;
        const saved = storage.getItem(key);
        if (saved !== null) return decodeBase64(saved, 'base64url').length === 32 ? saved : null;
        const fresh = encodeBase64(getRandomBytes(32), 'base64url');
        storage.setItem(key, fresh);
        // A failed/non-persistent store must never silently overwrite old ciphertext.
        return storage.getItem(key) === fresh ? fresh : null;
    } catch { return null; }
}
