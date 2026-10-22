const KEY = 'happy-tokenhub-session-notice';
export async function saveSessionNotice(message: string) { try { sessionStorage.setItem(KEY, message); } catch { /* Best-effort presentation only. */ } }
export async function readSessionNotice(): Promise<string | null> { try { return sessionStorage.getItem(KEY); } catch { return null; } }
export async function clearSessionNotice() { try { sessionStorage.removeItem(KEY); } catch { /* Best-effort presentation only. */ } }
