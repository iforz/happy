import { WorkMockError, type WorkMessage, type WorkMockUsage, type WorkModelCatalog } from './workMockClient';

export interface Turn { user: string; assistant: string; status: 'streaming' | 'complete' | 'cancelled' | 'failed'; usage?: WorkMockUsage }
export interface Conversation { id: string; model: string; turns: Turn[] }
export function conversationInput(turns: Turn[], question: string): WorkMessage[] {
    const messages: WorkMessage[] = turns.filter(turn => turn.status === 'complete').flatMap(turn => [{role:'user' as const, content:turn.user}, {role:'assistant' as const, content:turn.assistant}]);
    messages.push({role:'user',content:question});
    if (!question.trim() || messages.length > 49 || messages.some(m => !m.content.trim()) || messages.reduce((n,m) => n + m.content.length, 0) > 16000) throw new WorkMockError('invalid_request');
    return messages;
}
export function requireRealCatalog(catalog: WorkModelCatalog): WorkModelCatalog {
    if (catalog.mode !== 'real' || catalog.billable !== true) throw new WorkMockError('configuration');
    return catalog;
}
export function selectedModelAllowed(catalog: WorkModelCatalog | null, model: string): boolean {
    return !!catalog && catalog.mode === 'real' && catalog.models.some(item => item.id === model);
}
