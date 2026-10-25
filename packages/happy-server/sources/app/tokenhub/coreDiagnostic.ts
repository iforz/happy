// Only fixed service diagnostics may cross the Core/Work boundary.
export function coreDiagnostic(status: number, body: string): string | undefined {
    if (status !== 503 || body.length > 4096) return;
    try {
        const value = JSON.parse(body);
        const type = value?.error?.type;
        if (typeof type === 'string' && ['work_gateway_disabled', 'work_gateway_unavailable', 'work_authority_unavailable', 'work_key_lookup_unavailable'].includes(type)) return type;
    } catch { /* Never expose arbitrary upstream content. */ }
}
