// The existing sync engine is initialized once per JS runtime. Do not pretend a
// second login can reuse it safely after credentials have been removed.
export const RUNTIME_RESTART_MESSAGE = '此会话已停用，请先完成本机退出清理，再完全关闭并重新打开 App 后继续。';
let required = false;
export function requiresRuntimeRestart() { return required; }
export function markRuntimeRestartRequired() { required = true; }
