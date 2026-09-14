#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, identity, safeError, type ClientConfig } from './config.js';
import { BridgeClient } from './client.js';
import { runMcp } from './mcp.js';

const help = `nexus-bridge — send work to Nexus and read approved replies

  send --project <name|id> --thread <name|id> [--correlation <id>] <text|->
  send --retry <message-id>
  results [--follow]
  whoami
  mcp

Use --config <file> for non-secret YAML settings. Omit send text to read stdin.
Set NEXUS_BRIDGE_INSTANCE and NEXUS_BRIDGE_SENDER explicitly. See the operator guide
for backend/broker URLs and environment credentials. No command approves Nexus work.
`;
async function write(text: string): Promise<void> { await new Promise<void>((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve())); }
async function stdin(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Provide message text or pipe it on stdin.');
  const chunks: Buffer[] = []; let bytes = 0;
  const abort = () => process.stdin.destroy(); signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of process.stdin) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > 1048576) throw new Error('Message input exceeds 1 MiB.'); chunks.push(Buffer.from(chunk)); }
    signal.throwIfAborted(); return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abort); }
}
async function main() {
  let config: ClientConfig | undefined;
  let client: BridgeClient | undefined;
  const abort = new AbortController(); const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      config: { type: 'string' }, help: { type: 'boolean', short: 'h' }, follow: { type: 'boolean' },
      project: { type: 'string' }, thread: { type: 'string' }, correlation: { type: 'string' }, retry: { type: 'string' },
    } });
    if (values.help || !positionals.length) { await write(help); return; }
    const [command, ...text] = positionals;
    if (!['send', 'results', 'whoami', 'mcp'].includes(command)) throw new Error('Unknown command; use --help.');
    if ((command !== 'send' && (text.length || values.project || values.thread || values.correlation || values.retry)) || (command !== 'results' && values.follow)) throw new Error('Options do not match this command; use --help.');
    config = loadConfig(values.config);
    if (command === 'whoami') { await write(`${JSON.stringify(identity(config))}\n`); return; }
    client = new BridgeClient(config);
    if (command === 'mcp') { await runMcp(client); return; }
    if (command === 'send') {
      if (values.retry && (text.length || values.project || values.thread || values.correlation)) throw new Error('--retry cannot be combined with new content or target options.');
      const input = values.retry ? { retryId: values.retry } : { project: values.project, thread: values.thread, correlationId: values.correlation,
        content: text.length && !(text.length === 1 && text[0] === '-') ? text.join(' ') : await stdin(abort.signal) };
      const result = await client.send(input, abort.signal); await write(`${JSON.stringify(result)}\n`); return;
    }
    do {
      const batch = await client.readBatch(abort.signal);
      try {
        for (const result of batch.results) await write(`${JSON.stringify(result)}\n`);
        batch.delivered();
      } finally { batch.release(); }
      // fetch is bounded; follow repeats until interrupted, including empty polls.
    } while (values.follow && !abort.signal.aborted);
  } catch (error) {
    if (!abort.signal.aborted) { process.stderr.write(`${safeError(error, config)}\n`); process.exitCode = 1; }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await client?.close(); }
}
void main();
