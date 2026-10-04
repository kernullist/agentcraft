// Connections end to end (fake Claude SDK, fake HTTP): a DeepSeek connection is added and
// assigned to the workers from the protocol while the Foreman runs; the workers' turns then run
// with DeepSeek's endpoint and key, the lead's with the command-line Anthropic key; switching the
// workers back starts a new session (handover) instead of resuming the DeepSeek one; a connection
// whose key is rejected blocks only its role. The key never appears in anything sent to clients.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRunner, cliClaudeConnection } from '../src/agents/claude/index.js';
import { HANDOVER_PROMPT } from '../src/agents/team/backend.js';
import { RoutedBackend } from '../src/agents/team/routed.js';
import { ConnectionManager } from '../src/connections/manager.js';
import type { FetchFn } from '../src/connections/providers.js';
import { MemorySecretStore } from '../src/connections/secrets.js';
import { ConnectionStore } from '../src/connections/store.js';
import type { ClientMessage, Outbound } from '../src/protocol.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const SECRET = 'sk-deepseek-SECRET-9f8e';
type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const callTool = async (o: Options, name: string, args: Record<string, unknown>) =>
  (await (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools[name]!.handler(args, {})).content.map((c) => c.text).join('\n');

let n = 0;
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...o }) as unknown as SDKMessage;
const init = (s: string) => m({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const done = (s: string) => m({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0.5, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: 1000, output_tokens: 200 }, modelUsage: {}, permission_denials: [] });

interface Call {
  prompt: string;
  cwd: string;
  resume?: string;
  env: Record<string, string | undefined>;
  model?: string;
}
const calls: Call[] = [];
let session = 0;

function fakeQuery() {
  return ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const o = options!;
    const p = String(prompt);
    calls.push({ prompt: p, cwd: o.cwd ?? '', ...(o.resume ? { resume: o.resume } : {}), env: { ...(o.env ?? {}) }, ...(o.model ? { model: o.model } : {}) });
    async function* run(): AsyncGenerator<SDKMessage> {
      const s = o.resume ?? `00000000-0000-4000-9000-${String(++session).padStart(12, '0')}`;
      yield init(s);
      if (p.startsWith('New goal')) {
        await callTool(o, 'create_task', { title: 'Add hello', description: 'src/hello.js', assignee: 'kit' });
      } else if (/Your task: t1/.test(p)) {
        fs.mkdirSync(path.join(o.cwd!, 'src'), { recursive: true });
        fs.writeFileSync(path.join(o.cwd!, 'src', 'hello.js'), "export const hello = () => 'hi';\n");
        await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'added hello' });
      } else if (p.includes('requested changes')) {
        fs.appendFileSync(path.join(o.cwd!, 'src', 'hello.js'), '// reviewed\n');
        await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'changed' });
      } else if (/Review request: t1/.test(p)) {
        await callTool(o, 'request_merge', { task_id: 't1', summary: 'ok' });
      }
      yield done(s);
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x@example.com', apiKeySource: 'ANTHROPIC_API_KEY' }) });
  };
}

const fetchFn: FetchFn = async (_url, init) => {
  const bad = (init.headers.Authorization ?? '').includes('bad');
  return { status: bad ? 401 : 200, ok: !bad, json: async () => ({ data: [{ id: 'deepseek-pro' }, { id: 'deepseek-flash' }] }) };
};

let h: Harness;
let home: string;
let repoPath: string;
const savedKey = process.env.ANTHROPIC_API_KEY;

async function send(msg: Record<string, unknown>): Promise<Outbound[]> {
  const replies: Outbound[] = [];
  await h.fm.handle({ v: 1, id: `c${++n}`, ...msg } as unknown as ClientMessage, (r) => replies.push(r));
  return replies;
}
const ack = (rs: Outbound[]) => rs.find((r) => r.type === 'ack') as { ok: boolean; error?: string; result?: Record<string, unknown> };

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-cli-key';
  home = tempDir();
  repoPath = await demoRepo();
  h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repoPath]);
  const connections = new ConnectionManager(new ConnectionStore({ home, profile: h.cfg.profile, cli: cliClaudeConnection(h.cfg.claude), secrets: new MemorySecretStore() }));
  const backend = new RoutedBackend(h.fm, h.cfg.claude, { name: 'claude', connections, runners: (host) => ({ claude: new ClaudeRunner(host, h.cfg.claude, { queryFn: fakeQuery() as never, fetchFn }) }) });
  await h.fm.start(backend);
  await until(() => h.fm.status.auth === 'ok');
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

describe('connections at runtime', () => {
  it('adds DeepSeek, gives it to the workers, and runs their turns on it', async () => {
    const fm = h.fm;
    const snap = fm.snapshot() as { connections?: Array<{ id: string; roles: string[] }>; providers?: Array<{ id: string }> };
    expect(snap.connections!.map((c) => c.id)).toEqual(['cli']);
    expect(snap.providers!.map((p) => p.id)).toContain('deepseek');

    const saved = ack(await send({ type: 'connection.save', connection: { provider: 'deepseek', apiKey: SECRET } }));
    expect(saved.ok).toBe(true);
    const view = saved.result!.connection as { id: string; auth: string; secret: string; availableModels: string[] };
    expect(view).toMatchObject({ id: 'deepseek', auth: 'ok', secret: 'sk-…9f8e' });
    expect(view.availableModels).toEqual(['deepseek-pro', 'deepseek-flash']);
    expect(ack(await send({ type: 'connection.assign', connectionId: 'deepseek', role: 'workers' })).result).toEqual({ lead: 'cli', workers: 'deepseek' });

    const goal = await fm.submitGoal('Add a hello module');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 90_000);

    const lead = calls.find((c) => c.prompt.startsWith('New goal'))!;
    const kit = calls.find((c) => /Your task: t1/.test(c.prompt))!;
    expect(lead.env.ANTHROPIC_API_KEY).toBe('sk-ant-cli-key');
    // the command-line connection keeps the Foreman's environment as it is (whatever it says)
    expect(lead.env.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
    expect(lead.env.ANTHROPIC_AUTH_TOKEN).not.toBe(SECRET);
    expect(kit.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(kit.env.ANTHROPIC_AUTH_TOKEN).toBe(SECRET);
    expect(kit.env.ANTHROPIC_API_KEY).toBeUndefined(); // the Anthropic key never goes to DeepSeek
    // a real DeepSeek model id (the endpoint rejects Claude aliases with HTTP 400), pinned in every slot
    expect(kit.model).toBe('deepseek-flash');
    expect(kit.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-flash');
    expect(fm.store.data.sessions['kit:t1']!.connectionId).toBe('deepseek');
    expect(fm.store.data.sessions[`marlow:${goal.id}`]!.connectionId).toBeUndefined();
    // DeepSeek turns report tokens, not the SDK's Claude-priced USD
    expect(fm.store.logTail('kit').some((e) => e.text.includes('1,200 tokens'))).toBe(true);

    // switch the workers back: the next worker turn is a new session that re-reads the state
    await send({ type: 'connection.assign', connectionId: 'cli', role: 'workers' });
    const merge = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1')!;
    const before = calls.length;
    await fm.answerDecision(merge.id, 'Request changes', 'add a comment');
    await until(() => calls.slice(before).some((c) => c.prompt.includes('requested changes')), 30_000);
    const again = calls.slice(before).find((c) => c.prompt.includes('requested changes'))!;
    expect(again.resume).toBeUndefined();
    expect(again.prompt.startsWith(HANDOVER_PROMPT)).toBe(true);
    expect(again.env.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
    expect(again.env.ANTHROPIC_AUTH_TOKEN).not.toBe(SECRET);
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 90_000);
    await fm.answerDecision(fm.decisions.open().find((d) => d.kind === 'merge')!.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done');
    expect(fm.store.data.sessions['kit:t1']!.connectionId).toBeUndefined();
  }, 180_000);

  it('a model the endpoint does not offer fails at save time, not in the first turn', async () => {
    const saved = ack(await send({ type: 'connection.save', connection: { provider: 'deepseek', name: 'DS alias', apiKey: 'sk-ok-key-1234', models: { lead: 'opus' } } }));
    const c = saved.result!.connection as { id: string; auth: string; message: string };
    expect(c.auth).toBe('failed');
    expect(c.message).toContain('model opus is not offered');
    expect(c.message).toContain('deepseek-pro, deepseek-flash');
    await send({ type: 'connection.delete', connectionId: c.id });
  });

  it('a rejected key blocks only the role that uses it', async () => {
    const saved = ack(await send({ type: 'connection.save', connection: { provider: 'deepseek', name: 'DS bad', apiKey: 'bad-key-0000' } }));
    expect((saved.result!.connection as { auth: string }).auth).toBe('failed');
    await send({ type: 'connection.assign', connectionId: 'ds-bad', role: 'workers' });
    expect(h.fm.status.auth).toBe('failed');
    expect(h.fm.status.message).toContain('rejected the key');
    // the lead can still take a goal
    await expect(h.fm.submitGoal('Another goal')).resolves.toBeDefined();
    const rm = ack(await send({ type: 'connection.delete', connectionId: 'ds-bad' }));
    expect(rm.result).toEqual({ lead: 'cli', workers: 'cli' });
    await until(() => h.fm.status.auth === 'ok');
  });

  it('never sends the key to a client', () => {
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    expect(JSON.stringify(h.fm.snapshot())).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(home, 'connections.json'), 'utf8')).not.toContain(SECRET);
  });
});
