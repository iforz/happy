import * as SecureStore from 'expo-secure-store';
const KEY = 'happy.tokenhub.session.notice';
let current: string | null | undefined;
// A presentation-storage failure must not leave removed credentials displayed as authenticated.
export async function saveSessionNotice(message: string) { current = message; try { await SecureStore.setItemAsync(KEY, message); } catch {} }
export async function readSessionNotice() { if (current !== undefined) return current; try { return await SecureStore.getItemAsync(KEY); } catch { return null; } }
export async function clearSessionNotice() { current = null; try { await SecureStore.deleteItemAsync(KEY); } catch {} }
