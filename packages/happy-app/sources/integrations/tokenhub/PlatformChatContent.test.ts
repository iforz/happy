import { describe, expect, it, vi } from 'vitest';
vi.mock('@/components/ChatList', () => ({ AccountChatList: () => null }));
import { platformTurnsToMessages } from './PlatformChatContent';

describe('platform native message adapter', () => {
    it('preserves server turn identity, text and native newest-first order', () => {
        expect(platformTurnsToMessages('conversation', [
            { id: 'one', user: 'question', assistant: 'answer', status: 'complete' },
            { id: 'two', user: 'next', assistant: '', status: 'streaming' },
        ])).toEqual([
            { kind: 'user-text', id: 'conversation:two:user', localId: null, createdAt: 2, text: 'next' },
            { kind: 'agent-text', id: 'conversation:one:assistant', localId: null, createdAt: 1, text: 'answer' },
            { kind: 'user-text', id: 'conversation:one:user', localId: null, createdAt: 0, text: 'question' },
        ]);
    });
    it('keeps row identity stable while an answer streams without device pending state', () => {
        const turn = { user: 'hello', assistant: 'a', status: 'streaming' as const };
        const initial = platformTurnsToMessages('new', [turn]);
        const updated = platformTurnsToMessages('new', [{ ...turn, assistant: 'answer' }]);
        expect(updated.map(message => message.id)).toEqual(initial.map(message => message.id));
        expect(updated[0].text).toBe('answer');
        expect(updated[1]).not.toHaveProperty('pending');
        expect(platformTurnsToMessages('new', [])).toEqual([]);
    });
});
