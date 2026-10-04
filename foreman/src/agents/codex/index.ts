// Codex backend: OpenAI Codex (the official `codex app-server`) runs the lead and the workers, on
// the user's ChatGPT subscription signed in with a device code (auth.ts). The orchestration is the
// shared TeamBackend; this file runs one turn per app-server process:
//
//   spawn `codex app-server` with the agent's environment (git safety, its own git identity)
//   initialize (experimental API: dynamic tools)
//   thread/start (new session) or thread/resume (session id = thread id)
//   turn/start -> notifications (CodexMapper) + server requests:
//     item/commandExecution/requestApproval, item/fileChange/requestApproval -> TeamBackend.gate
//       (policy.ts, in-game permission prompts, "Always allow" rules), accept / decline
//     item/tool/call -> the team tools (agents/team/tools.ts)
//   turn/completed -> TurnStats; the process is closed (its tree killed if it lingers)
//
// Sandbox: the lead runs read-only, a worker workspace-write in its worktree (no network). Approval
// policy "untrusted": Codex asks before anything it does not consider a safe read, and the
// Foreman's policy decides. Every command inherits the full environment (incl. GIT_CONFIG_KEY_n,
// which Codex's default excludes would drop), so git refuses pushes inside Codex too.
import path from 'node:path';
import { z } from 'zod';
import type { CodexConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { killTree } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { TeamBackend, teamEnv, type Role, type TurnSpec, type TurnStats } from '../team/backend.js';
import { buildTeamTools, type TeamTool } from '../team/tools.js';
import { AppServerClient, resolveCodexCommand, type CodexCommand } from './appserver.js';
import { deviceCodeMessage, describeAccount, ensureChatgptLogin } from './auth.js';
import { CodexMapper, fileChangeTool } from './stream.js';

/** Config every agent thread runs with (app-server `config` overrides, TOML paths). */
export const CODEX_THREAD_CONFIG: Record<string, unknown> = {
  // commands get the agent's whole environment: the git safety variables (GIT_CONFIG_KEY_n
  // contains "KEY", which the default excludes would drop) and the agent's git identity
  'shell_environment_policy.inherit': 'all',
  'shell_environment_policy.ignore_default_excludes': true,
  // like the claude backend's disallowed WebSearch/WebFetch
  web_search: 'disabled',
  // no network from the sandbox (git transports are refused by git itself as well)
  'sandbox_workspace_write.network_access': false,
};

export interface CodexBackendOptions {
  /** injectable for tests: how to start one app-server */
  startServer?: (env: NodeJS.ProcessEnv, cwd: string | undefined) => AppServerClient;
  /** skip the startup sign-in check (tests) */
  skipAuthCheck?: boolean;
}

interface CodexTurnResult {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string; codexErrorInfo?: unknown } | null;
}

export class CodexBackend extends TeamBackend {
  readonly name = 'codex' as const;
  protected readonly label = 'Codex';
  private readonly cmd: CodexCommand;
  private login: AbortController | undefined;

  constructor(
    fm: Foreman,
    private codexCfg: CodexConfig,
    private opts: CodexBackendOptions = {},
  ) {
    super(fm, codexCfg);
    this.cmd = resolveCodexCommand(codexCfg.codexBin);
  }

  protected modelFor(role: Role): string {
    return (role === 'lead' ? this.codexCfg.leadModel : this.codexCfg.workerModel) ?? 'codex default';
  }

  protected authFailureMessage(detail: string, thrown: boolean): string {
    return `Codex sign-in failed${thrown ? ': ' : ' ('}${detail}${thrown ? '' : ')'}. Restart the Foreman to sign in to ChatGPT again (a new device code is shown).`;
  }

  /** Environment of an agent's app-server (and every command it runs). */
  private env(who: { agentId?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
    return { ...teamEnv(process.env, who), CODEX_HOME: this.codexCfg.codexHome } as NodeJS.ProcessEnv;
  }

  private startServer(env: NodeJS.ProcessEnv, cwd: string | undefined, tag: string): AppServerClient {
    if (this.opts.startServer) return this.opts.startServer(env, cwd);
    return new AppServerClient({ cmd: this.cmd, env, ...(cwd ? { cwd } : {}), onStderr: (l) => this.fm.log.debug(`[${tag} codex] ${l.slice(0, 300)}`) });
  }

  private statusMessage(): string {
    return `Codex (lead ${this.modelFor('lead')}, workers ${this.modelFor('worker')})`;
  }

  /**
   * Signed in already: ok at once. Otherwise the device-code sign-in runs in the background (the
   * Foreman keeps serving the game): the code goes to the banner, the console and a notification,
   * and the team starts as soon as Codex reports the sign-in.
   */
  async checkAuth(): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: this.statusMessage() });
      return true;
    }
    this.fm.setStatus({ auth: 'checking', message: 'Checking the Codex sign-in...' });
    let client: AppServerClient;
    try {
      client = this.startServer(this.env(), undefined, 'auth');
      await client.initialize('agentcraft_foreman', FOREMAN_VERSION);
    } catch (e) {
      this.markAuthFailed(`Could not start the Codex CLI (${truncate((e as Error).message, 160)}). Install it with \`npm i -g @openai/codex\` (or pass --codex-bin), then restart the Foreman. The sim backend still works.`);
      return false;
    }
    // until the sign-in is done nothing may run (the scheduler checks authFailed)
    this.authFailed = true;
    this.login = new AbortController();
    const signal = this.login.signal;
    const done = ensureChatgptLogin(client, {
      signal,
      onCode: (d) => {
        const msg = deviceCodeMessage(d);
        this.fm.setStatus({ auth: 'checking', message: msg });
        this.fm.log.info(msg);
        this.fm.bus.feed('system', msg);
        // in-game toast + desktop notification (and the console bell): the user has to act
        this.fm.notify('need_user', msg);
        this.fm.notifier.needUser(msg);
      },
    })
      .then((r) => {
        if (r.ok) {
          this.authFailed = false;
          const account = describeAccount(r.account);
          this.fm.setStatus({ auth: 'ok', account, message: this.statusMessage() });
          this.fm.log.info(`codex auth ok (${account}, CODEX_HOME ${this.codexCfg.codexHome})`);
          this.tick();
          return true;
        }
        if (!signal.aborted) this.markAuthFailed(`Codex sign-in did not complete (${r.error}). Restart the Foreman for a new device code. The sim backend still works.`);
        return false;
      })
      .catch((e) => {
        if (!signal.aborted) this.markAuthFailed(`Codex sign-in failed: ${truncate((e as Error).message, 160)}. Restart the Foreman to try again.`);
        return false;
      })
      .finally(() => {
        void client.close(1000).then((exited) => {
          if (!exited) killTree(client.child);
        });
      });
    // already signed in: account/read answers at once, so wait briefly for that case
    return Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(false), 3000).unref?.())]);
  }

  override async stop(): Promise<void> {
    this.login?.abort();
    await super.stop();
  }

  /** The team tools as Codex dynamic tools (JSON schema from the zod shapes). */
  private dynamicTools(tools: TeamTool[]): unknown[] {
    return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) }));
  }

  protected async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const { agentId, role, cwd, entry, turn } = spec;
    const cfg = this.codexCfg;
    const client = this.startServer(this.env({ agentId, cwd }), cwd, agentId);
    entry.child = client.child;
    entry.spawnedAt = client.spawnedAt;
    const mapper = new CodexMapper(this.fm, agentId, cwd, role);
    const tools = buildTeamTools(this.fm, agentId, role, this.hooks, turn);
    const byName = new Map(tools.map((t) => [t.name, t]));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let onCompleted!: (t: CodexTurnResult | undefined) => void;
    const completed = new Promise<CodexTurnResult | undefined>((res) => (onCompleted = res));

    client.onAnyNotification((method, params) => {
      if (turn.signal.aborted) return; // nothing from an aborted turn reaches the world
      mapper.handle(method, params);
    });
    client.onNotification('turn/completed', (p) => {
      const t = (p as { turn?: CodexTurnResult }).turn;
      if (!turnId || t?.id === turnId) onCompleted(t);
    });
    client.onRequest('item/tool/call', async (p) => {
      const call = p as { tool: string; arguments: unknown };
      const tool = byName.get(call.tool);
      if (!tool) return { contentItems: [{ type: 'inputText', text: `Error: no tool ${call.tool}` }], success: false };
      const parsed = z.object(tool.shape).safeParse(call.arguments ?? {});
      if (!parsed.success) return { contentItems: [{ type: 'inputText', text: `Error: bad arguments for ${call.tool}: ${truncate(parsed.error.message, 400)}` }], success: false };
      const r = await tool.handler(parsed.data);
      return { contentItems: r.content.map((c) => ({ type: 'inputText', text: c.text })), success: !r.isError };
    });
    client.onRequest('item/commandExecution/requestApproval', async (p) => {
      const a = p as { command?: string | null; cwd?: string | null; reason?: string | null };
      const g = await this.gate(agentId, role, cwd, turn, turn.signal, 'Bash', { command: a.command ?? '' }, a.reason ?? undefined);
      if (!g.allow) this.fm.log.debug(`${agentId}: declined command: ${g.message}`);
      return { decision: g.allow ? 'accept' : 'decline' };
    });
    client.onRequest('item/fileChange/requestApproval', async (p) => {
      const a = p as { itemId: string; reason?: string | null; grantRoot?: string | null };
      const changes = mapper.fileChanges.get(a.itemId) ?? [];
      // a write-access grant for a whole directory (no file list): judge it as a write there
      const asks = changes.length ? changes.map((c) => fileChangeTool(c, cwd)) : [{ tool: 'Write' as const, input: { file_path: path.resolve(cwd, a.grantRoot ?? '.') } }];
      for (const ask of asks) {
        const g = await this.gate(agentId, role, cwd, turn, turn.signal, ask.tool, ask.input, a.reason ?? undefined);
        if (!g.allow) return { decision: 'decline' };
      }
      return { decision: 'accept' };
    });
    // extra sandbox permissions (network, more file system): never granted to agents
    client.onRequest('item/permissions/requestApproval', (p) => {
      const a = p as { reason?: string | null };
      this.fm.agentLog(agentId, 'error', `declined a sandbox permission request${a.reason ? `: ${truncate(a.reason, 200)}` : ''}`);
      return { permissions: {}, scope: 'turn' };
    });
    // questions go through ask_user (an in-game decision), not Codex's own prompt
    client.onRequest('item/tool/requestUserInput', () => ({ answers: {} }));

    const interrupt = () => {
      if (threadId && turnId) void client.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => undefined);
      onCompleted(undefined);
    };
    if (turn.signal.aborted) interrupt();
    else turn.signal.addEventListener('abort', interrupt, { once: true });

    try {
      await client.initialize('agentcraft_foreman', FOREMAN_VERSION);
      const model = role === 'lead' ? cfg.leadModel : cfg.workerModel;
      const effort = role === 'lead' ? cfg.leadEffort : cfg.effort;
      const threadParams = {
        cwd,
        approvalPolicy: 'untrusted',
        sandbox: role === 'lead' ? 'read-only' : 'workspace-write',
        developerInstructions: spec.systemPrompt,
        config: CODEX_THREAD_CONFIG,
        ...(model ? { model } : {}),
      };
      const started = spec.resume
        ? await client.request<{ thread: { id: string }; model?: string }>('thread/resume', { threadId: spec.resume, ...threadParams })
        : await client.request<{ thread: { id: string }; model?: string }>('thread/start', { ...threadParams, dynamicTools: this.dynamicTools(tools) });
      threadId = started.thread.id;
      mapper.stats.sessionId = threadId;
      if (this.fm.store.data.sessions[spec.job.sessionKey]?.sessionId !== threadId) this.recordSession(spec.job.sessionKey, threadId, spec.model);
      if (started.model && !model) this.fm.log.debug(`${agentId}: codex model ${started.model}`);
      if (turn.signal.aborted) return mapper.stats;
      const t = await client.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: spec.prompt, text_elements: [] }],
        ...(effort ? { effort } : {}),
      });
      turnId = t.turn.id;
      const result = await Promise.race([completed, client.exited.then(() => undefined)]);
      if (turn.signal.aborted) return mapper.stats;
      if (!result && !client.alive) throw new Error('codex app-server exited during the turn');
      return mapper.finish(result);
    } finally {
      turn.signal.removeEventListener('abort', interrupt);
      // an aborted turn's process tree is reaped by TeamBackend; a finished one is closed here
      if (!turn.signal.aborted) {
        const exited = await client.close(2000);
        if (!exited) killTree(client.child);
      }
    }
  }
}
