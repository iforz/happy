export interface NativeSessionStopNoticeProps {
    cleanupRequired: boolean;
    restartRequired: boolean;
    remoteStatus: 'confirmed' | 'unconfirmed' | null;
    retry: () => Promise<void>;
}
/** Web retains its existing logout/reload presentation. */
export function NativeSessionStopNotice(_props: NativeSessionStopNoticeProps) { return null; }
