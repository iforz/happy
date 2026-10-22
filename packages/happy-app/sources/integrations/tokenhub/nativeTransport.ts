import { fetch as expoFetch } from 'expo/fetch';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeWorkFetch } from './nativeRequestContext';

/** SDK transport supports incremental ReadableStream, abort and redirect:'error' on iOS/Android. */
export const nativeFetch: typeof fetch = nativeWorkFetch(expoFetch as unknown as typeof fetch, getServerUrl);
export async function nativeRequest(server: string, path: string, body: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await nativeFetch(server + path, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) {
            if (response.status === 412) throw new Error('网络环境变化，会话失效，请重新登录。');
            if (response.status === 409) throw new Error('请先恢复原来的 Happy 加密身份，再登录此账号。');
            throw new Error('登录未完成或已过期，请重新开始。');
        }
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('登录响应无效。');
        const text = await response.text();
        if (text.length > 65536) throw new Error('登录响应无效。');
        return JSON.parse(text);
    } finally { clearTimeout(timer); }
}
