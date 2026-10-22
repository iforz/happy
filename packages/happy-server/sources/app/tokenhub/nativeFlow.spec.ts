import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalNativeIP, nativeRequestBinding, NATIVE_WORK_USER_AGENT } from './nativeFlow';
it.each([
    ['127.0.0.1', '127.0.0.1'], ['::ffff:127.0.0.1', '127.0.0.1'], ['::ffff:7f00:1', '127.0.0.1'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'], ['::1', '::1'],
])('canonicalizes %s consistently with the Core IP+UA contract', (input, canonical) => {
    expect(canonicalNativeIP(input)).toBe(canonical);
    expect(nativeRequestBinding(input, NATIVE_WORK_USER_AGENT)).toBe(createHash('sha256').update(canonical + '\n' + NATIVE_WORK_USER_AGENT).digest('hex').slice(0, 32));
});
it.each(['browser-UA', 'TokenHubWorkNative/1 extra', undefined])('rejects an unexpected app UA %s', ua => {
    expect(() => nativeRequestBinding('127.0.0.1', ua)).toThrow('native_context_changed');
});
