import type { AuthCredentials } from '@/auth/tokenStorage';
export async function preserveTokenHubIdentity(_credentials: AuthCredentials | null) {}
export async function clearTokenHubLocalSession() {}
export function watchTokenHubSession(_credentials: AuthCredentials | null, _expired: () => Promise<void>): () => void { return () => {}; }

export function invalidateTokenHubLogin() {}
