// Claude backend: real Claude Agent SDK sessions for the lead and workers. The orchestration (job
// queues, scheduling, CI + review, steering, restart recovery) lives in agents/team/backend.ts;
// this file runs one turn as an SDK `query()` and checks Claude authentication.
import { spawn } from 'node:child_process';
import { query, type CanUseTool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { TeamBackend, teamEnv, type Role, type TurnSpec, type TurnStats } from '../team/backend.js';
import type { TurnHandle } from '../team/tools.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';
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
}

export class ClaudeBackend extends TeamBackend {
  readonly name = 'claude' as const;
  protected readonly label = 'Claude';
  private readonly queryFn: typeof query;

  constructor(
    fm: Foreman,
    private claudeCfg: ClaudeConfig,
    private opts: ClaudeBackendOptions = {},
  ) {
    super(fm, claudeCfg);
    this.queryFn = opts.queryFn ?? query;
  }

  protected modelFor(role: Role): string {
    return role === 'lead' ? this.claudeCfg.leadModel : this.claudeCfg.workerModel;
  }

  protected authFailureMessage(detail: string, thrown: boolean): string {
    return thrown ? `Claude authentication failed: ${detail}` : `Claude authentication failed (${detail}). Run \`claude\` and /login, then restart the Foreman.`;
  }

  private env(who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
    return withAuthMode(agentEnv(process.env, who), this.claudeCfg.useClaudeLogin);
  }

  async checkAuth(): Promise<boolean> {
    const cfg = this.claudeCfg;
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: `Claude (lead ${cfg.leadModel}, workers ${cfg.workerModel})` });
      return true;
    }
    // API authentication by default; the claude.ai login only when explicitly opted into
    const api = detectApiAuth(process.env);
    if (!cfg.useClaudeLogin && !api.ok) {
      this.markAuthFailed(NO_API_AUTH_MESSAGE);
      return false;
    }
    this.fm.setStatus({ auth: 'checking', message: cfg.useClaudeLogin ? 'Checking Claude login...' : 'Checking Claude API access...' });
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: this.env() } });
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timed out after 45s')), 45_000))]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      const account = cfg.useClaudeLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
      this.authFailed = false;
      this.fm.setStatus({ auth: 'ok', account, message: `Claude (lead ${cfg.leadModel}, workers ${cfg.workerModel})` });
      this.fm.log.info(`claude auth ok (${account})`);
      return true;
    } catch (e) {
      this.markAuthFailed(
        cfg.useClaudeLogin
          ? `Claude login check failed: ${(e as Error).message}. Run \`claude\` and /login, then restart the Foreman. The sim backend still works.`
          : `Claude API check failed: ${(e as Error).message}. Check ANTHROPIC_API_KEY (or your cloud provider settings), then restart the Foreman. The sim backend still works.`,
      );
      return false;
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
      const r = await this.gate(agentId, role, cwd, turn, opts.signal, toolName, input, opts.title);
      if (r.allow) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: r.message, ...(r.interrupt ? { interrupt: true } : {}) };
    };
  }

  protected async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const { job, agentId, role, cwd, model, entry, turn } = spec;
    const cfg = this.claudeCfg;
    const abort = entry.abort;
    const options: Options = {
      cwd,
      model,
      effort: role === 'lead' ? cfg.leadEffort : cfg.effort,
      maxTurns: role === 'lead' ? cfg.maxTurnsLead : cfg.maxTurnsWorker,
      settingSources: [],
      permissionMode: 'default',
      canUseTool: this.canUseTool(agentId, role, cwd, turn),
      tools: role === 'lead' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      // no allowedTools: every tool call (incl. our MCP tools) goes through canUseTool/policy
      disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
      mcpServers: { [MCP_SERVER]: buildMcpServer(this.fm, agentId, role, this.hooks, turn) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPrompt },
      abortController: abort,
      env: this.env({ agentId, cwd }),
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
      ...(cfg.maxBudgetUsdPerTurn ? { maxBudgetUsd: cfg.maxBudgetUsdPerTurn } : {}),
    };
    const mapper = new StreamMapper(this.fm, agentId, cwd, role);
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
        this.recordSession(job.sessionKey, mapper.stats.sessionId, model);
      }
    }
    return mapper.stats;
  }
}
