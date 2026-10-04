// The codex backend against a scripted fake `codex app-server` (test/fixtures/fake-codex.mjs):
// device-code sign-in, thread/turn flow, approvals through the permission gate, dynamic team
// tools, git safety in the agent environment, and a whole goal from plan to merge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexBackend } from '../src/agents/codex/index.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');

interface LogEntry {
  start?: boolean;
  env?: Record<string, string>;
  in?: { method?: string; params?: Record<string, unknown> };
  approval?: string;
  command?: string;
  file?: string;
  decision?: string;
  toolResult?: string;
}

function readLog(file: string): LogEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}

function setup(dir: string, scenario: unknown): { scenarioFile: string; logFile: string } {
  const scenarioFile = path.join(dir, 'scenario.json');
  const logFile = path.join(dir, 'fake-codex.log');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  process.env.FAKE_CODEX_SCENARIO = scenarioFile;
  process.env.FAKE_CODEX_LOG = logFile;
  return { scenarioFile, logFile };
}

describe('codex backend: device-code sign-in', () => {
  let h: Harness;
  let home: string;
  let logFile: string;

  beforeAll(() => {
    home = tempDir();
    ({ logFile } = setup(home, { account: null, loginDelayMs: 300, turns: [] }));
    h = makeForeman(home, ['--backend', 'codex', '--codex-bin', FAKE]);
  });
  afterAll(async () => {
    await h.fm.close();
    rmrf(home);
  });

  it('shows the device code, then becomes ok with the ChatGPT account', async () => {
    const b = new CodexBackend(h.fm, h.cfg.codex);
    await h.fm.start(b);
    await until(() => h.fm.status.auth === 'ok');
    // on the way: the device code was shown (banner status, notification)
    const statuses = h.events.filter((e) => e.type === 'foreman.status').map((e) => (e as { status: { auth: string; message?: string } }).status);
    const code = statuses.find((s) => (s.message ?? '').includes('ABCD-1234'))!;
    expect(code.auth).toBe('checking');
    expect(code.message).toContain('https://auth.example/device');
    expect(h.toasts.some((t) => t.body.includes('ABCD-1234'))).toBe(true);
    // and in the activity feed (console)
    expect(h.events.some((e) => e.type !== 'foreman.status' && JSON.stringify(e).includes('ABCD-1234'))).toBe(true);
    expect(h.fm.status.account).toBe('alex@example.com · plus');
    // the agents' own CODEX_HOME, not ~/.codex
    const start = readLog(logFile).find((e) => e.start)!;
    expect(start.env!.CODEX_HOME).toBe(path.join(home, 'codex', 'codex'));
  });
});

describe('codex backend: a goal from plan to merge (fake app-server)', () => {
  let h: Harness;
  let home: string;
  let repoPath: string;
  let logFile: string;

  beforeAll(async () => {
    home = tempDir();
    repoPath = await demoRepo();
    ({ logFile } = setup(home, {
      account: { type: 'chatgpt', email: 'alex@example.com', planType: 'pro' },
      turns: [
        {
          match: 'New goal',
          steps: [
            { tool: 'write_memory', args: { title: 'Plan: hello', body: '- t1 add hello', scope: 'shared' } },
            { tool: 'create_task', args: { title: 'Add hello module', description: 'src/hello.js exporting hello()', assignee: 'kit' } },
            { message: 'Planned one task.' },
          ],
        },
        {
          match: 'Your task: t1',
          steps: [
            { command: 'git push origin main' },
            { file: 'src/hello.js', content: "export const hello = () => 'hi';\n" },
            { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'added src/hello.js' } },
          ],
        },
        { match: 'Review request: t1', steps: [{ tool: 'request_merge', args: { task_id: 't1', summary: 'Adds hello().' } }] },
      ],
    }));
    h = makeForeman(home, ['--backend', 'codex', '--codex-bin', FAKE, '--workers', 'kit', '--repo', repoPath]);
    await h.fm.start(new CodexBackend(h.fm, h.cfg.codex));
    await until(() => h.fm.status.auth === 'ok');
  });

  afterAll(async () => {
    await h.fm.close();
    rmrf(home);
    rmrf(path.dirname(repoPath));
  });

  it('plans, works, gates approvals, reviews and merges', async () => {
    const fm = h.fm;
    const goal = await fm.submitGoal('Add a hello module');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 90_000);
    const m = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1')!;
    expect(m.context).toContain('Adds hello().');
    await fm.answerDecision(m.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done');
    expect(fs.readFileSync(path.join(repoPath, 'src', 'hello.js'), 'utf8')).toContain('hello');

    const log = readLog(logFile);
    // policy: a push is declined, a write inside the worktree is accepted
    expect(log.find((e) => e.approval === 'command' && e.command === 'git push origin main')!.decision).toBe('decline');
    const fileApproval = log.find((e) => e.approval === 'file')!;
    expect(fileApproval.decision).toBe('accept');
    expect(fileApproval.file).toContain(path.join('worktrees', 'demo-app'));

    // threads: lead read-only in the repo, worker workspace-write in its worktree, team tools as
    // dynamic tools, full environment for commands
    const starts = log.filter((e) => e.in?.method === 'thread/start').map((e) => e.in!.params!);
    const lead = starts.find((p) => fs.realpathSync(String(p.cwd)) === fs.realpathSync(repoPath))!;
    const worker = starts.find((p) => String(p.cwd).includes('worktrees'))!;
    expect(lead.sandbox).toBe('read-only');
    expect(worker.sandbox).toBe('workspace-write');
    expect(worker.approvalPolicy).toBe('untrusted');
    expect((lead.dynamicTools as Array<{ name: string }>).map((t) => t.name)).toContain('create_task');
    expect((worker.dynamicTools as Array<{ name: string }>).map((t) => t.name)).not.toContain('create_task');
    const config = worker.config as Record<string, unknown>;
    expect(config['shell_environment_policy.inherit']).toBe('all');
    expect(config['shell_environment_policy.ignore_default_excludes']).toBe(true);
    expect(String(worker.developerInstructions)).toContain('worker on an AgentCraft team');

    // the worker's app-server (and so its commands) runs with git safety and its own identity
    const envs = log.filter((e) => e.start).map((e) => e.env!);
    const kitEnv = envs.find((e) => e.GIT_AUTHOR_NAME === 'AgentCraft Kit')!;
    expect(kitEnv.GIT_ALLOW_PROTOCOL).toBe('agentcraft-none');
    expect(Object.values(kitEnv)).toContain('protocol.allow');

    // sessions = Codex thread ids; logs mapped from notifications
    expect(fm.store.data.sessions['kit:t1']!.sessionId).toMatch(/^thread-/);
    const kitLog = fm.store.logTail('kit').map((e) => `${e.kind}:${e.text}`);
    expect(kitLog.some((l) => l.startsWith('tool:$ git push origin main'))).toBe(true);
    expect(kitLog.some((l) => l.startsWith('tool:Write src/hello.js'))).toBe(true);
    expect(kitLog.some((l) => l.includes('1,234 tokens'))).toBe(true);
  }, 120_000);
});
