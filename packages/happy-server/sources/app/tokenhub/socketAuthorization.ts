import type { Server, Socket } from 'socket.io';
import { WORK_REVALIDATE_MS, type VerifiedWorkSession, type WorkAuthorization } from './workAuthorization';

/** The same authorization verifier as HTTP runs before Socket.IO announces a successful connection. */
export function installWorkSocketAuthentication(io: Server, authorization: WorkAuthorization): void {
    io.use(async (socket, next) => {
        const { token, clientType, sessionId, machineId } = socket.handshake.auth;
        if (typeof token !== 'string' || !token) return next(new Error('Missing authentication token'));
        if (clientType === 'session-scoped' && (typeof sessionId !== 'string' || !sessionId)) return next(new Error('Session ID required for session-scoped clients'));
        if (clientType === 'machine-scoped' && (typeof machineId !== 'string' || !machineId)) return next(new Error('Machine ID required for machine-scoped clients'));
        try {
            const verified = await authorization.verifyToken(token, { ip: socket.handshake.address, userAgent: socket.handshake.headers['user-agent'] });
            if (!verified) return next(new Error('Invalid authentication token'));
            socket.data.userId = verified.userId;
            socket.data.workSession = verified;
            socket.data.clientType = clientType;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            socket.data.happyClient = socket.handshake.auth.happyClient as string
                || socket.handshake.headers['x-happy-client'] as string || undefined;
            next();
        } catch { next(new Error('Invalid authentication token')); }
    });
}

/** Protect every inbound application event and revoke idle sockets within 15s + the 2s authority timeout. */
export function protectWorkSocket(socket: Socket, token: string, initial: VerifiedWorkSession, authorization: WorkAuthorization): void {
    if (!authorization.enabled) return;
    let stopped = false;
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = initial.expiresAt ?? 0;
    const cleanup = () => {
        stopped = true;
        clearTimeout(checkTimer);
        clearTimeout(expiryTimer);
    };
    const reject = () => {
        if (stopped) return;
        cleanup();
        socket.emit('auth-error', { error: 'Session authorization expired or revoked' });
        socket.disconnect(true);
    };
    function scheduleExpiry() {
        clearTimeout(expiryTimer);
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) { reject(); return; }
        // Avoid Node's timeout overflow, and re-check long-lived expirations safely.
        expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
        expiryTimer.unref?.();
    }
    async function reauthorize(): Promise<boolean> {
        if (stopped) return false;
        const verified = await authorization.verifyToken(token, { ip: socket.handshake.address, userAgent: socket.handshake.headers['user-agent'] }).catch(() => null);
        if (stopped) return false;
        if (!verified || verified.userId !== initial.userId || !verified.expiresAt || verified.expiresAt <= Date.now()) {
            reject(); return false;
        }
        expiresAt = Math.min(expiresAt, verified.expiresAt);
        scheduleExpiry();
        return !stopped;
    }
    socket.once('disconnect', cleanup);
    socket.use(async (_packet, next) => {
        // No whitelist: new handlers are protected automatically. Never share a cached authorization result.
        if (await reauthorize()) next();
        else next(new Error('Session authorization failed'));
    });
    function scheduleCheck() {
        if (stopped) return;
        checkTimer = setTimeout(async () => {
            if (await reauthorize()) scheduleCheck();
        }, WORK_REVALIDATE_MS);
        checkTimer.unref?.();
    }
    scheduleExpiry();
    scheduleCheck();
}
