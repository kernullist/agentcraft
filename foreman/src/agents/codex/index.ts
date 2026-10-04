// Codex runtime: OpenAI Codex (the official `codex app-server`) runs the lead and/or the workers on
// a ChatGPT connection, signed in with a device code (auth.ts). The orchestration is the shared
// TeamBackend, the connection routing agents/team/routed.ts; this file runs one turn per
// app-server process:
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
import { ConnectionManager } from '../../connections/manager.js';
import { modelFor } from '../../connections/providers.js';
import { MemorySecretStore } from '../../connections/secrets.js';
import { ConnectionStore } from '../../connections/store.js';
import { CLI_CONNECTION_ID, type Connection } from '../../connections/types.js';
import { killTree } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { teamEnv, type TurnSpec, type TurnStats } from '../team/backend.js';
import { RoutedBackend, type AuthReport, type RunnerHost, type RuntimeRunner } from '../team/routed.js';
import { buildTeamTools, type TeamTool } from '../team/tools.js';
import { AppServerClient, bundledCodex, resolveCodexCommand, versionFromUserAgent, type CodexCommand } from './appserver.js';
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

/** The connection `--backend codex` (flags, env, config.json) describes. */
export function cliCodexConnection(cfg: CodexConfig): Connection {
  const models = { ...(cfg.leadModel ? { lead: cfg.leadModel } : {}), ...(cfg.workerModel ? { worker: cfg.workerModel } : {}) };
  return {
    id: CLI_CONNECTION_ID,
    name: 'Codex',
    provider: 'chatgpt',
    ...(Object.keys(models).length ? { models } : {}),
    codexHome: cfg.codexHome,
    source: 'cli',
    createdAt: 0,
  };
}

export class CodexRunner implements RuntimeRunner {
  readonly runtime = 'codex' as const;
  private readonly cmd: CodexCommand;
  private readonly bundled = bundledCodex();
  private readonly logins = new Map<string, AbortController>();
  private versionChecked = false;

  constructor(
    private host: RunnerHost,
    private cfg: CodexConfig,
    private opts: CodexBackendOptions = {},
  ) {
    this.cmd = resolveCodexCommand(cfg.codexBin, process.env, this.bundled ?? null);
  }

  private get fm(): Foreman {
    return this.host.fm;
  }

  authFailureMessage(conn: Connection, detail: string, thrown: boolean): string {
    return `${conn.name}: Codex sign-in failed${thrown ? ': ' : ' ('}${detail}${thrown ? '' : ')'}. Sign in again from the Connections screen (/connect), or restart the Foreman (a new device code is shown).`;
  }

  private codexHome(conn: Connection): string {
    return conn.codexHome ?? this.cfg.codexHome;
  }

  /** Environment of an agent's app-server (and every command it runs). */
  private env(conn: Connection, who: { agentId?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
    return { ...teamEnv(process.env, who), CODEX_HOME: this.codexHome(conn) } as NodeJS.ProcessEnv;
  }

  private startServer(env: NodeJS.ProcessEnv, cwd: string | undefined, tag: string): AppServerClient {
    if (this.opts.startServer) return this.opts.startServer(env, cwd);
    return new AppServerClient({ cmd: this.cmd, env, ...(cwd ? { cwd } : {}), onStderr: (l) => this.fm.log.debug(`[${tag} codex] ${l.slice(0, 300)}`) });
  }

  /**
   * The bundled CLI is the tested one. Another one (--codex-bin, PATH) may speak a different
   * app-server protocol (dynamic tools are experimental): say so, but let it run.
   */
  private checkVersion(running: string | undefined): void {
    if (this.versionChecked) return;
    this.versionChecked = true;
    const tested = this.bundled?.version;
    this.fm.log.info(`codex CLI ${running ?? '?'} (${this.cmd.source}${this.cmd.source === 'bundled' ? '' : `, tested with ${tested ?? '?'}`})`);
    if (this.cmd.source !== 'bundled' && tested && running && running !== tested) {
      const msg = `Codex CLI ${running} is not the version AgentCraft is tested with (${tested}); its app-server protocol may differ. Drop --codex-bin to use the bundled one.`;
      this.fm.log.warn(msg);
      this.fm.bus.feed('system', msg);
    }
  }

  private okMessage(conn: Connection): string {
    return `${conn.name} (lead ${modelFor(conn, 'lead') ?? 'codex default'}, workers ${modelFor(conn, 'worker') ?? 'codex default'})`;
  }

  /**
   * Signed in already: ok at once. Otherwise the device-code sign-in runs in the background (the
   * Foreman keeps serving the game): the code goes to the banner, the console and a notification,
   * and the connection becomes ok as soon as Codex reports the sign-in.
   */
  async check(conn: Connection, _secret: string | undefined, report: (r: AuthReport) => void): Promise<void> {
    if (this.opts.skipAuthCheck) {
      report({ auth: 'ok', message: this.okMessage(conn) });
      return;
    }
    if (this.logins.has(conn.id)) return; // a sign-in for it is already waiting on the user
    report({ auth: 'checking', message: 'Checking the Codex sign-in...' });
    let client: AppServerClient;
    try {
      client = this.startServer(this.env(conn), undefined, 'auth');
      const init = await client.initialize('agentcraft_foreman', FOREMAN_VERSION);
      this.checkVersion(versionFromUserAgent(init.userAgent));
    } catch (e) {
      const hint = this.cmd.source === 'explicit' ? 'Check --codex-bin' : 'Run `npm ci` in foreman/ (it installs the Codex CLI the Foreman uses)';
      report({ auth: 'failed', message: `Could not start the Codex CLI (${truncate((e as Error).message, 160)}). ${hint}, then restart the Foreman. The sim backend still works.` });
      return;
    }
    const login = new AbortController();
    this.logins.set(conn.id, login);
    const signal = login.signal;
    const done = ensureChatgptLogin(client, {
      signal,
      onCode: (d) => {
        const msg = deviceCodeMessage(d);
        report({ auth: 'checking', message: msg });
        this.fm.log.info(msg);
        this.fm.bus.feed('system', msg);
        // in-game toast + desktop notification (and the console bell): the user has to act
        this.fm.notify('need_user', msg);
        this.fm.notifier.needUser(msg);
      },
    })
      .then((r) => {
        if (r.ok) {
          const account = describeAccount(r.account);
          report({ auth: 'ok', account, message: this.okMessage(conn) });
          this.fm.log.info(`codex auth ok (${account}, CODEX_HOME ${this.codexHome(conn)})`);
          return;
        }
        if (!signal.aborted) report({ auth: 'failed', message: `Codex sign-in did not complete (${r.error}). Sign in again from the Connections screen (/connect) or restart the Foreman for a new device code. The sim backend still works.` });
      })
      .catch((e) => {
        if (!signal.aborted) report({ auth: 'failed', message: `Codex sign-in failed: ${truncate((e as Error).message, 160)}. Try again from the Connections screen (/connect).` });
      })
      .finally(() => {
        this.logins.delete(conn.id);
        void client.close(1000).then((exited) => {
          if (!exited) killTree(client.child);
        });
      });
    // already signed in: account/read answers at once, so wait briefly for that case
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 3000).unref?.())]);
  }

  stop(): void {
    for (const l of this.logins.values()) l.abort();
  }

  /** The team tools as Codex dynamic tools (JSON schema from the zod shapes). */
  private dynamicTools(tools: TeamTool[]): unknown[] {
    return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) }));
  }

  async runTurn(spec: TurnSpec, conn: Connection): Promise<TurnStats> {
    const { agentId, role, cwd, entry, turn } = spec;
    const cfg = this.cfg;
    const client = this.startServer(this.env(conn, { agentId, cwd }), cwd, agentId);
    entry.child = client.child;
    entry.spawnedAt = client.spawnedAt;
    const mapper = new CodexMapper(this.fm, agentId, cwd, role);
    const tools = buildTeamTools(this.fm, agentId, role, this.host.hooks, turn);
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
      const g = await this.host.gate(agentId, role, cwd, turn, turn.signal, 'Bash', { command: a.command ?? '' }, a.reason ?? undefined);
      if (!g.allow) this.fm.log.debug(`${agentId}: declined command: ${g.message}`);
      return { decision: g.allow ? 'accept' : 'decline' };
    });
    client.onRequest('item/fileChange/requestApproval', async (p) => {
      const a = p as { itemId: string; reason?: string | null; grantRoot?: string | null };
      const changes = mapper.fileChanges.get(a.itemId) ?? [];
      // a write-access grant for a whole directory (no file list): judge it as a write there
      const asks = changes.length ? changes.map((c) => fileChangeTool(c, cwd)) : [{ tool: 'Write' as const, input: { file_path: path.resolve(cwd, a.grantRoot ?? '.') } }];
      for (const ask of asks) {
        const g = await this.host.gate(agentId, role, cwd, turn, turn.signal, ask.tool, ask.input, a.reason ?? undefined);
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
      const model = modelFor(conn, role);
      // effort: the command line's for the cli connection, else the connection's
      const effort = conn.source === 'cli' ? (role === 'lead' ? cfg.leadEffort : cfg.effort) : conn.effort;
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
      if (this.fm.store.data.sessions[spec.job.sessionKey]?.sessionId !== threadId) this.host.recordSession(spec.job.sessionKey, threadId, spec.model);
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

/** A team on one Codex connection: the `--backend codex` command line (tests use it directly). */
export class CodexBackend extends RoutedBackend {
  constructor(fm: Foreman, cfg: CodexConfig, opts: CodexBackendOptions = {}) {
    super(fm, cfg, {
      name: 'codex',
      label: 'Codex',
      connections: new ConnectionManager(new ConnectionStore({ home: fm.config.home, profile: fm.config.profile, cli: cliCodexConnection(cfg), secrets: new MemorySecretStore(), persist: false })),
      runners: (host) => ({ codex: new CodexRunner(host, cfg, opts) }),
    });
  }
}
