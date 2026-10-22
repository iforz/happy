import * as React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import type { NativeSessionStopNoticeProps } from './NativeSessionStopNotice';

/** Owned above navigation so a retained account/session screen cannot hide this state. */
export function NativeSessionStopNotice({ cleanupRequired, restartRequired, remoteStatus, retry }: NativeSessionStopNoticeProps) {
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const retrying = React.useRef(false);
    const tryCleanup = async () => {
        if (retrying.current) return;
        retrying.current = true; setBusy(true); setFailed(false);
        try { await retry(); } catch { setFailed(true); }
        finally { retrying.current = false; setBusy(false); }
    };
    return <Modal visible={cleanupRequired || restartRequired} transparent={false} presentationStyle="fullScreen"
        animationType="none" allowSwipeDismissal={false} onRequestClose={() => { /* An invalidated runtime cannot expose the old navigation again. */ }}>
        <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: '#f4f5f7', padding: 28, justifyContent: 'center', alignItems: 'center' }}>
            <View style={{ width: '100%', maxWidth: 520, gap: 20 }}>
                <Text accessibilityRole="header" style={{ color: '#111827', fontSize: 24, fontWeight: '600' }}>本机会话已停用</Text>
                <Text accessibilityRole="alert" style={{ color: '#374151', fontSize: 17, lineHeight: 26 }}>{cleanupRequired
                    ? '本机凭据尚未清除。请解锁设备后重试清理；清理成功前不会自动重启或重新登录。'
                    : '本机授权已清除，原有加密身份已保留。请完全关闭并重新打开 App 后继续。'}</Text>
                {remoteStatus ? <Text accessibilityRole="alert" style={{ color: '#374151', lineHeight: 24 }}>{remoteStatus === 'confirmed'
                    ? '已确认撤销当前 TokenHub 远端会话。'
                    : '远端撤销未确认，请联系管理员确认远端会话是否已撤销。'}</Text> : null}
                {cleanupRequired ? <Pressable accessibilityRole="button" accessibilityLabel="重试本机退出清理" disabled={busy}
                    onPress={() => { void tryCleanup(); }} style={{ backgroundColor: '#1f2937', padding: 16, borderRadius: 12, opacity: busy ? 0.6 : 1 }}>
                    <Text style={{ color: '#fff', textAlign: 'center', fontSize: 17 }}>{busy ? '正在清理…' : '重试本机退出清理'}</Text>
                </Pressable> : null}
                {failed && cleanupRequired ? <Text accessibilityRole="alert" style={{ color: '#9f1239' }}>清理尚未成功。请解锁设备后重试，旧会话仍保持停用。</Text> : null}
            </View>
        </View>
    </Modal>;
}
