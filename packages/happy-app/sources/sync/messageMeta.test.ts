vi.mock('@/text',()=>({getCurrentLanguage:()=> 'en'}));
import { describe, expect, it, vi } from 'vitest';
import { resolveMessageDeliveryMeta, resolveMessageModeMeta, UnsupportedPermissionModeError } from './messageMeta';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

describe('resolveMessageDeliveryMeta', () => {
    const idle = {
        metadata: {
            ...rigMetadataFixture,
            capabilities: { ...rigMetadataFixture.capabilities!, messageReceipts: true },
        },
        thinking: false,
        agentState: null,
    };

    it('tracks acceptance without showing a queue status for an idle agent', () => {
        expect(resolveMessageDeliveryMeta(idle)).toEqual({ expectsAcceptance: true, queuedWhileBusy: false });
    });

    it('shows the queue status when sending during an existing turn', () => {
        expect(resolveMessageDeliveryMeta({ ...idle, thinking: true }))
            .toEqual({ expectsAcceptance: true, queuedWhileBusy: true });
    });

    it('queues a rapid follow-up behind a locally pending message before thinking updates', () => {
        expect(resolveMessageDeliveryMeta(idle, false, true))
            .toEqual({ expectsAcceptance: true, queuedWhileBusy: true });
    });

    it('treats a blocked permission request as busy even if thinking is false', () => {
        expect(resolveMessageDeliveryMeta({
            ...idle,
            agentState: { requests: { permission: { tool: 'Bash', arguments: {} } } },
        }).queuedWhileBusy).toBe(true);
    });

    it('does not label an answer to an agent question as queued', () => {
        expect(resolveMessageDeliveryMeta({
            ...idle,
            thinking: true,
            agentState: {
                requests: {},
                communications: {
                    question: {
                        kind: 'form',
                        form: {
                            questions: [{
                                id: 'choice', header: 'Choice', question: 'Pick one',
                                options: [{ label: 'One' }],
                            }],
                        },
                    },
                },
            },
        } as any).queuedWhileBusy).toBe(false);
    });

    it.each([false, true])('never labels the first message as queued during startup (thinking=%s)', (thinking) => {
        expect(resolveMessageDeliveryMeta({ ...idle, thinking }, true))
            .toEqual({ expectsAcceptance: true, queuedWhileBusy: false });
    });

    it('keeps the send-time decision when that message starts its own turn', () => {
        const session = { ...idle };
        const meta = resolveMessageDeliveryMeta(session);
        session.thinking = true;
        expect(meta.queuedWhileBusy).toBe(false);
    });

    it('does not mark sessions that cannot acknowledge messages', () => {
        expect(resolveMessageDeliveryMeta({ ...idle, metadata: rigMetadataFixture, thinking: true })).toEqual({});
    });
});

describe('resolveMessageModeMeta',()=>{
 const session=(modelMode:string|null, models:any[]=[])=>({permissionMode:null,modelMode,effortLevel:null,metadata:{flavor:'codex',version:'1.2.6',models}} as any);
 it('rejects missing capabilities instead of a code default',()=>expect(()=>resolveMessageModeMeta(session(null))).toThrow());
 it('rejects saved selections missing from the current device catalog',()=>expect(()=>resolveMessageModeMeta(session('stale-model',[{code:'real-model',value:'Real'}]))).toThrow());
 it('rejects a synthetic default even when old metadata lists it',()=>expect(()=>resolveMessageModeMeta(session('default',[{code:'default',value:'Default'}]))).toThrow());
 it('sends the exact verified device model',()=>expect(resolveMessageModeMeta(session('real-model',[{code:'real-model',value:'Real'}])).model).toBe('real-model'));
 it('retains existing permission compatibility checks',()=>expect(()=>resolveMessageModeMeta({...session('real-model',[{code:'real-model',value:'Real'}]),permissionMode:'auto',metadata:{flavor:'codex',version:'1.2.0',models:[{code:'real-model',value:'Real'}]}})).toThrow(UnsupportedPermissionModeError));
});
