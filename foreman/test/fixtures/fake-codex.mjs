// A scripted stand-in for `codex app-server` (JSON-RPC over stdio) for the codex backend tests.
//   FAKE_CODEX_SCENARIO  JSON file: { account, loginDelayMs, turns: [{ match, steps }] }
//   FAKE_CODEX_LOG       JSONL file: every message from the client + the process env, appended
// Steps (run in order on turn/start for the first turn whose `match` is in the prompt):
//   { tool, args }              item/tool/call (dynamic tool) and wait for the reply
//   { command }                 commandExecution item + approval request
//   { file, content, kind }     fileChange item + approval request; written to cwd if accepted
//   { message }                 agentMessage item
//   { fail, info }              end the turn as failed with that error
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const logFile = process.env.FAKE_CODEX_LOG;
const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`);
const accountFile = `${process.env.FAKE_CODEX_SCENARIO}.account.json`;
const account = () => (fs.existsSync(accountFile) ? JSON.parse(fs.readFileSync(accountFile, 'utf8')) : scenario.account ?? null);
const pick = (prefix) => Object.fromEntries(Object.entries(process.env).filter(([k]) => prefix.some((p) => k.startsWith(p))));
log({ start: true, pid: process.pid, cwd: process.cwd(), env: pick(['GIT_', 'CODEX_HOME']) });

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    waiting.set(id, res);
    send({ id, method, params });
  });
const threads = new Map(); // id -> { cwd, params }
let threadSeq = 0;
let turnSeq = 0;
let item = 0;

async function runTurn(threadId, turnId, prompt) {
  const th = threads.get(threadId);
  const script = scenario.turns.find((t) => prompt.includes(t.match)) ?? { steps: [] };
  for (const s of script.steps) {
    const id = `item-${++item}`;
    if (s.tool) {
      send({ method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'dynamicToolCall', id, namespace: null, tool: s.tool, arguments: s.args, status: 'inProgress', contentItems: null, success: null, durationMs: null } } });
      const r = await request('item/tool/call', { threadId, turnId, callId: id, namespace: null, tool: s.tool, arguments: s.args });
      log({ toolResult: s.tool, result: r });
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'dynamicToolCall', id, namespace: null, tool: s.tool, arguments: s.args, status: r.success ? 'completed' : 'failed', contentItems: r.contentItems, success: r.success, durationMs: 1 } } });
    } else if (s.command) {
      const base = { type: 'commandExecution', id, command: s.command, cwd: th.cwd, processId: null, source: 'agent', commandActions: [], pluginId: null, scriptPath: null };
      send({ method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null } } });
      const r = await request('item/commandExecution/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now(), environmentId: null, command: s.command, cwd: th.cwd });
      log({ approval: 'command', command: s.command, decision: r.decision });
      const ok = r.decision === 'accept';
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { ...base, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'ok\n' : null, exitCode: ok ? 0 : null, durationMs: 1 } } });
    } else if (s.file) {
      const abs = path.isAbsolute(s.file) ? s.file : path.join(th.cwd, s.file);
      const changes = [{ path: abs, kind: { type: s.kind ?? 'add' }, diff: `+${s.content}` }];
      send({ method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id, changes, status: 'inProgress' } } });
      const r = await request('item/fileChange/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now() });
      log({ approval: 'file', file: abs, decision: r.decision });
      if (r.decision === 'accept') {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, s.content);
      }
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id, changes, status: r.decision === 'accept' ? 'completed' : 'declined' } } });
    } else if (s.message) {
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id, text: s.message, phase: null, memoryCitation: null } } });
    } else if (s.fail) {
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'failed', error: { message: s.fail, codexErrorInfo: s.info ?? null, additionalDetails: null }, startedAt: null, completedAt: null, durationMs: null } } });
      return;
    }
  }
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { totalTokens: 1234, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 234, reasoningOutputTokens: 0 }, last: null, modelContextWindow: null } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } } });
}

async function handle(m) {
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex/0.0.0', codexHome: process.env.CODEX_HOME, platformFamily: 'test', platformOs: 'test' });
    case 'account/read':
      return reply({ account: account(), requiresOpenaiAuth: true });
    case 'account/login/start':
      reply({ type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' });
      setTimeout(() => {
        fs.writeFileSync(accountFile, JSON.stringify({ type: 'chatgpt', email: 'alex@example.com', planType: 'plus' }));
        send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null, onboardingEntrypoint: null } });
      }, scenario.loginDelayMs ?? 100);
      return;
    case 'account/login/cancel':
      return reply({ status: 'canceled' });
    case 'thread/start': {
      const id = `thread-${process.pid}-${++threadSeq}`;
      threads.set(id, { cwd: m.params.cwd, params: m.params });
      return reply({ thread: { id }, model: 'fake-model' });
    }
    case 'thread/resume': {
      threads.set(m.params.threadId, { cwd: m.params.cwd, params: m.params });
      return reply({ thread: { id: m.params.threadId }, model: 'fake-model' });
    }
    case 'turn/start': {
      const turnId = `turn-${++turnSeq}`;
      reply({ turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } });
      const prompt = (m.params.input ?? []).map((i) => i.text ?? '').join('\n');
      void runTurn(m.params.threadId, turnId, prompt);
      return;
    }
    case 'turn/interrupt':
      return reply({});
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  log({ in: m });
  if (m.method === undefined && m.id !== undefined) {
    waiting.get(m.id)?.(m.result ?? { error: m.error });
    waiting.delete(m.id);
    return;
  }
  if (m.method && m.id !== undefined) void handle(m);
});
process.stdin.on('end', () => process.exit(0));
