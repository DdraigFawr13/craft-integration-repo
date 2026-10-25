// A stand-in MCP server for tests. FAKE_MODE picks its behaviour: ok, tool-error, or crash.
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'crash') {
  process.stderr.write('fake server could not start\n');
  process.exit(3);
}
const tools = [{ name: 'list_commands' }, { name: 'get_text' }];
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1.0' }, capabilities: { tools: {} } });
  else if (msg.method === 'tools/list' && !msg.params?.cursor) reply(msg.id, { tools: tools.slice(0, 1), nextCursor: 'page2' });
  else if (msg.method === 'tools/list') reply(msg.id, { tools: tools.slice(1) });
  else if (msg.method === 'tools/call') {
    const isError = mode === 'tool-error';
    reply(msg.id, { content: [{ type: 'text', text: isError ? 'no document' : 'hello' }], isError });
  }
});
