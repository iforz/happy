import * as React from 'react';
import { AccountChatList } from '@/components/ChatList';
import type { AgentTextMessage, UserTextMessage } from '@/sync/typesMessage';
import type { Turn } from './conversation';

export type PlatformDisplayTurn = Turn & { id?: string };

/** Translate server turns into Happy's native message model, newest first. */
export function platformTurnsToMessages(conversationId: string, turns: PlatformDisplayTurn[]): Array<UserTextMessage | AgentTextMessage> {
    const messages: Array<UserTextMessage | AgentTextMessage> = [];
    turns.forEach((turn, index) => {
        const id = `${conversationId}:${turn.id ?? index}`;
        // The server turn order is authoritative. Stable logical timestamps avoid
        // moving bubbles on each streamed update or inventing a device outbox.
        const createdAt = index * 2;
        messages.push({ kind: 'user-text', id: `${id}:user`, localId: null, createdAt, text: turn.user });
        if (turn.assistant) {
            messages.push({ kind: 'agent-text', id: `${id}:assistant`, localId: null, createdAt: createdAt + 1, text: turn.assistant });
        }
    });
    return messages.reverse();
}

/** No device identity: rendering, markdown and scrolling all belong to Happy. */
export const PlatformChatContent = React.memo((props: {
    conversationId: string;
    turns: PlatformDisplayTurn[];
    onSendMessage: (text: string) => void | Promise<void>;
    streaming?: boolean;
    topContentInset?: number;
    bottomContentInset?: number;
    scrollButtonInset?: number;
}) => {
    const messages = React.useMemo(() => platformTurnsToMessages(props.conversationId, props.turns), [props.conversationId, props.turns]);
    return <AccountChatList {...props} messages={messages} />;
});
