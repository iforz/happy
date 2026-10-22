import { createMockProvider } from '../sources/app/tokenhub/mockProvider';

const port = Number(process.env.TOKENHUB_MOCK_PORT ?? '3099');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TOKENHUB_MOCK_PORT');
const server = createMockProvider();
server.listen(port, '127.0.0.1', () => console.log(`MOCK ONLY / NOT BILLED: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
