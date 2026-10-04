// Claude runtime: real Claude Agent SDK sessions (the Claude Code CLI) for the lead and workers.
// The orchestration (job queues, scheduling, CI + review, steering, restart recovery) lives in
// agents/team/backend.ts and the connection routing in agents/team/routed.ts; this file runs one
// turn as an SDK `query()` on a connection and checks a connection's access.
//
// Every Claude-runtime provider (environment, Anthropic API, claude.ai login, cloud, DeepSeek,
// Anthropic-compatible endpoints) runs this same CLI; connections/providers.ts gives each its
// environment.
import { spawn } from 'node:child_process';
import { query, type CanUseTool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { ConnectionManager } from '../../connections/manager.js';
import { claudeEnv, ConnectionTestError, listModels, modelFor, provider, type FetchFn } from '../../connections/providers.js';
import { MemorySecretStore } from '../../connections/secrets.js';
import { ConnectionStore } from '../../connections/store.js';
import { CLI_CONNECTION_ID, type Connection } from '../../connections/types.js';
import { teamEnv, type Role, type TurnSpec, type TurnStats } from '../team/backend.js';
import { RoutedBackend, type AuthReport, type RunnerHost, type RuntimeRunner } from '../team/routed.js';
import type { TurnHandle } from '../team/tools.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE } from './auth.js';
import { StreamMapper } from './stream.js';
import { buildMcpServer, MCP_SERVER } from './tools.js';

/**
 * Environment for an agent's CLI process (and every command it runs): the team environment (no
 * git transports, no signing, the agent's own git identity, git stays below the cwd), plus each
 * Bash call starts in the agent's own cwd, so a `cd` in one command cannot carry the next one out
 * of the worktree.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
  return teamEnv(base, who, {
    CLAUDE_AGENT_SDK_CLIENT_APP: `agentcraft-foreman/${FOREMAN_VERSION}`,
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
  });
}

export interface ClaudeBackendOptions {
  /** injectable for tests */
  queryFn?: typeof query;
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
  /** injectable for tests (API-key connection tests) */
  fetchFn?: FetchFn;
}

/** The connection `--backend claude` (flags, env, config.json) describes. */
export function cliClaudeConnection(cfg: ClaudeConfig): Connection {
  return {
    id: CLI_CONNECTION_ID,
    name: 'Claude',
    provider: 'claude-env',
    models: { lead: cfg.leadModel, worker: cfg.workerModel },
    useClaudeLogin: cfg.useClaudeLogin,
    source: 'cli',
    createdAt: 0,
  };
}

export class ClaudeRunner implements RuntimeRunner {
  readonly runtime = 'claude' as const;
  private readonly queryFn: typeof query;
  private readonly fetchFn: FetchFn;

  constructor(
    private host: RunnerHost,
    private cfg: ClaudeConfig,
    private opts: ClaudeBackendOptions = {},
  ) {
    this.queryFn = opts.queryFn ?? query;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private get fm(): Foreman {
    return this.host.fm;
  }

  private okMessage(conn: Connection, available?: string[]): string {
    return `${conn.name} (lead ${modelFor(conn, 'lead', available) ?? 'default'}, workers ${modelFor(conn, 'worker', available) ?? 'default'})`;
  }

  private env(conn: Connection, secret: string | undefined, model: string | undefined, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
    return claudeEnv(agentEnv(process.env, who), conn, secret, model);
  }

  authFailureMessage(conn: Connection, detail: string, thrown: boolean): string {
    if (conn.provider === 'claude-env' || conn.provider === 'claude-login') {
      return thrown ? `Claude authentication failed: ${detail}` : `Claude authentication failed (${detail}). Run \`claude\` and /login, then restart the Foreman.`;
    }
    return `${conn.name}: authentication failed${thrown ? ': ' : ' ('}${detail}${thrown ? '' : ')'}. Check the connection's key in the Connections screen (/connect).`;
  }

  async check(conn: Connection, secret: string | undefined, report: (r: AuthReport) => void): Promise<void> {
    if (this.opts.skipAuthCheck) {
      report({ auth: 'ok', message: this.okMessage(conn) });
      return;
    }
    const p = provider(conn.provider);
    // API-key endpoints: list the models (proves the key, costs no tokens)
    if (p.needsSecret) {
      report({ auth: 'checking', message: `Checking ${conn.name}...` });
      try {
        const models = await listModels(conn, secret, this.fetchFn);
        // a model the user named that the endpoint does not list fails every turn: say so now
        const missing = models.length ? (['lead', 'worker'] as const).map((r) => conn.models?.[r]).filter((m): m is string => !!m && !models.includes(m)) : [];
        if (missing.length) {
          report({ auth: 'failed', message: `${conn.name}: model ${missing.join(', ')} is not offered by the endpoint (it lists ${models.join(', ')}). Fix the model in the Connections screen (/connect).`, models });
          return;
        }
        report({ auth: 'ok', message: this.okMessage(conn, models), account: `${p.label}${models.length ? ` · ${models.length} models` : ''}`, models });
      } catch (e) {
        const msg = e instanceof ConnectionTestError ? e.message : (e as Error).message;
        report({ auth: 'failed', message: `${conn.name}: ${msg}. Fix it in the Connections screen (/connect). The sim backend still works.` });
      }
      return;
    }
    // environment / claude.ai login / cloud: ask the CLI who it is signed in as
    const useLogin = conn.provider === 'claude-login' || !!conn.useClaudeLogin;
    const api = detectApiAuth(process.env);
    if (conn.provider === 'claude-env' && !useLogin && !api.ok) {
      report({ auth: 'failed', message: NO_API_AUTH_MESSAGE });
      return;
    }
    report({ auth: 'checking', message: useLogin ? 'Checking Claude login...' : 'Checking Claude API access...' });
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: this.env(conn, secret, undefined) } });
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timed out after 45s')), 45_000))]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      const account = useLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : conn.provider === 'cloud'
          ? info.apiProvider ?? 'cloud'
          : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
      report({ auth: 'ok', account, message: this.okMessage(conn) });
      this.fm.log.info(`claude auth ok (${account})`);
    } catch (e) {
      report({
        auth: 'failed',
        message: useLogin
          ? `Claude login check failed: ${(e as Error).message}. Run \`claude\` and /login, then restart the Foreman. The sim backend still works.`
          : `Claude API check failed: ${(e as Error).message}. Check ANTHROPIC_API_KEY (or your cloud provider settings), then restart the Foreman. The sim backend still works.`,
      });
    } finally {
      try {
        q.close();
      } catch {
        /* ignore */
      }
    }
  }

  private canUseTool(agentId: string, role: Role, cwd: string, turn: TurnHandle): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      const r = await this.host.gate(agentId, role, cwd, turn, opts.signal, toolName, input, opts.title);
      if (r.allow) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: r.message, ...(r.interrupt ? { interrupt: true } : {}) };
    };
  }

  async runTurn(spec: TurnSpec, conn: Connection, secret: string | undefined): Promise<TurnStats> {
    const { job, agentId, role, cwd, model, entry, turn } = spec;
    const cfg = this.cfg;
    const p = provider(conn.provider);
    const abort = entry.abort;
    // effort: the command line's for the cli connection, else the connection's (when supported)
    const effort = !p.effort ? undefined : conn.source === 'cli' ? (role === 'lead' ? cfg.leadEffort : cfg.effort) : ((conn.effort as Options['effort']) ?? (role === 'lead' ? cfg.leadEffort : cfg.effort));
    const options: Options = {
      cwd,
      model,
      ...(effort ? { effort } : {}),
      maxTurns: role === 'lead' ? cfg.maxTurnsLead : cfg.maxTurnsWorker,
      settingSources: [],
      permissionMode: 'default',
      canUseTool: this.canUseTool(agentId, role, cwd, turn),
      tools: role === 'lead' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      // no allowedTools: every tool call (incl. our MCP tools) goes through canUseTool/policy
      disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
      mcpServers: { [MCP_SERVER]: buildMcpServer(this.fm, agentId, role, this.host.hooks, turn) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPrompt },
      abortController: abort,
      env: this.env(conn, secret, model, { agentId, cwd }),
      // we spawn the CLI ourselves (same as the SDK's local spawn) so its pid is known: a stopped
      // turn's whole process tree can then be ended before its worktree is handed on
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (s: string) => this.fm.log.debug(`[${agentId} stderr] ${s.trim().slice(0, 300)}`));
        child.on('error', (e) => this.fm.log.debug(`[${agentId}] CLI process error: ${e.message}`));
        entry.child = child;
        entry.spawnedAt = Date.now();
        return child;
      },
      ...(spec.resume ? { resume: spec.resume } : {}),
      // a USD cap only means something where the SDK knows the prices
      ...(cfg.maxBudgetUsdPerTurn && p.sdkCost ? { maxBudgetUsd: cfg.maxBudgetUsdPerTurn } : {}),
    };
    const mapper = new StreamMapper(this.fm, agentId, cwd, role, { sdkCost: p.sdkCost });
    const q = this.queryFn({ prompt: spec.prompt, options });
    // the abort signal alone lets a CLI finish what it is doing (seen in a real run: ~6 s of
    // further turns after /stop). close() force-ends the subprocess and its transports.
    const closeQuery = () => {
      try {
        q.close();
      } catch {
        /* already closed */
      }
    };
    if (abort.signal.aborted) closeQuery();
    else abort.signal.addEventListener('abort', closeQuery, { once: true });
    for await (const msg of q) {
      if (abort.signal.aborted) break; // nothing from an aborted turn reaches the world
      mapper.handle(msg);
      if (mapper.stats.sessionId && this.fm.store.data.sessions[job.sessionKey]?.sessionId !== mapper.stats.sessionId) {
        this.host.recordSession(job.sessionKey, mapper.stats.sessionId, model);
      }
    }
    return mapper.stats;
  }
}

/** A team on one Claude connection: the `--backend claude` command line (tests use it directly). */
export class ClaudeBackend extends RoutedBackend {
  constructor(fm: Foreman, cfg: ClaudeConfig, opts: ClaudeBackendOptions = {}) {
    super(fm, cfg, {
      name: 'claude',
      label: 'Claude',
      connections: new ConnectionManager(new ConnectionStore({ home: fm.config.home, profile: fm.config.profile, cli: cliClaudeConnection(cfg), secrets: new MemorySecretStore(), persist: false })),
      runners: (host) => ({ claude: new ClaudeRunner(host, cfg, opts) }),
    });
  }
}
