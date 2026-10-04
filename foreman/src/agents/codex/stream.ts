// Map codex app-server notifications -> agent.log entries + agent state/station, the same way
// the claude StreamMapper does for Agent SDK messages (both use agents/activity.ts).
//
//   item/started    commandExecution / fileChange / dynamicToolCall -> tool log + state
//   item/completed  agentMessage / reasoning -> text; tool items -> result or error
//   turn/completed  -> TurnStats (status, error, token usage)
import path from 'node:path';
import type { Foreman } from '../../foreman.js';
import { firstLine, headLines, tailLines, truncate } from '../../util/text.js';
import { relPath, toolActivity } from '../activity.js';
import type { Role, TurnStats } from '../team/backend.js';

interface FileChange {
  path: string;
  kind?: { type?: string };
  diff?: string;
}

/** The ThreadItem fields the mapper reads (codex app-server v2). */
export interface CodexItem {
  type: string;
  id: string;
  text?: string;
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: FileChange[];
  tool?: string;
  arguments?: unknown;
  contentItems?: Array<{ type: string; text?: string }> | null;
  success?: boolean | null;
}

interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null } | null;
}

/** Codex's error kinds that mean "sign in again". */
function isAuthError(info: unknown, message: string): boolean {
  if (info === 'unauthorized') return true;
  return /\b(401|unauthori[sz]ed|not logged in|login required|re-?authenticate|token (expired|revoked))\b/i.test(message);
}

/** The tool name + input the permission gate and activity map understand, for a file change. */
export function fileChangeTool(change: FileChange, cwd: string): { tool: 'Write' | 'Edit'; input: Record<string, unknown> } {
  const abs = path.isAbsolute(change.path) ? change.path : path.resolve(cwd, change.path);
  return { tool: change.kind?.type === 'add' ? 'Write' : 'Edit', input: { file_path: abs } };
}

export class CodexMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };
  /** file changes by item id: approval requests only carry the item id */
  readonly fileChanges = new Map<string, FileChange[]>();
  private tokens = 0;
  private steps = 0;

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: Role,
  ) {}

  private setState(act: ReturnType<typeof toolActivity>): void {
    this.fm.setAgent(this.agentId, { state: act.state, station: act.station, activity: act.activity });
    if ((act.state === 'editing' || act.state === 'running' || act.state === 'testing') && this.role === 'worker') {
      const repoId = this.fm.agent(this.agentId)?.repoId;
      if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
    }
  }

  private thinking(activity: string): void {
    const a = this.fm.agent(this.agentId);
    if (a && a.state !== 'waiting_user') this.fm.setAgent(this.agentId, { state: 'thinking', activity });
  }

  handle(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/started':
        this.started(p.item as CodexItem);
        break;
      case 'item/completed':
        this.completed(p.item as CodexItem);
        break;
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage as { total?: { totalTokens?: number } } | undefined;
        if (typeof u?.total?.totalTokens === 'number') this.tokens = u.total.totalTokens;
        break;
      }
      case 'error': {
        const e = p.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        const msg = e?.message ?? 'error';
        if (p.willRetry) {
          this.fm.agentLog(this.agentId, 'text', `Codex: ${truncate(msg, 200)} (retrying)`);
        } else {
          this.stats.errors.push(msg);
          if (isAuthError(e?.codexErrorInfo, msg)) this.stats.authFailed = firstLine(msg, 200);
          this.fm.agentLog(this.agentId, 'error', `Codex error: ${truncate(msg, 400)}`);
        }
        break;
      }
      case 'account/rateLimits/updated': {
        const rl = p.rateLimits as { rateLimitReachedType?: string | null; primary?: { usedPercent?: number } | null } | undefined;
        if (rl?.rateLimitReachedType) {
          this.fm.agentLog(this.agentId, 'error', `ChatGPT usage limit reached (${rl.rateLimitReachedType.replace(/_/g, ' ')})`);
          this.fm.setAgent(this.agentId, { state: 'blocked', activity: 'usage limit - waiting' });
        }
        break;
      }
      default:
        break;
    }
  }

  private started(item: CodexItem | undefined): void {
    if (!item) return;
    const id = this.agentId;
    switch (item.type) {
      case 'commandExecution': {
        this.steps++;
        const act = toolActivity('Bash', { command: item.command ?? '' }, this.cwd);
        this.fm.agentLog(id, 'tool', act.label);
        this.setState(act);
        break;
      }
      case 'fileChange': {
        this.steps++;
        const changes = item.changes ?? [];
        this.fileChanges.set(item.id, changes);
        for (const c of changes.slice(0, 6)) {
          const { tool, input } = fileChangeTool(c, this.cwd);
          const act = toolActivity(tool, input, this.cwd);
          this.fm.agentLog(id, 'tool', act.label);
          const diff = this.diffLines(c);
          if (diff) this.fm.agentLog(id, 'diff', diff);
          this.setState(act);
        }
        if (changes.length > 6) this.fm.agentLog(id, 'tool', `... and ${changes.length - 6} more files`);
        break;
      }
      case 'dynamicToolCall': {
        this.steps++;
        const input = (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown>;
        const act = toolActivity(item.tool ?? '?', input, this.cwd);
        this.fm.agentLog(id, 'tool', act.label);
        this.setState(act);
        break;
      }
      case 'reasoning':
        this.thinking('thinking');
        break;
      case 'webSearch':
        this.fm.setAgent(id, { state: 'reading', station: 'library', activity: 'searching the web' });
        break;
      default:
        break;
    }
  }

  private completed(item: CodexItem | undefined): void {
    if (!item) return;
    const id = this.agentId;
    switch (item.type) {
      case 'agentMessage': {
        const text = item.text?.trim();
        if (!text) break;
        this.stats.resultText = text;
        this.fm.agentLog(id, 'text', truncate(text, 1200));
        this.thinking(firstLine(text, 48));
        break;
      }
      case 'reasoning': {
        const s = (item.summary ?? []).join(' ').trim();
        if (s) this.fm.agentLog(id, 'text', `~ ${truncate(s.replace(/\s+/g, ' '), 300)}`);
        break;
      }
      case 'commandExecution': {
        const out = item.aggregatedOutput ?? '';
        if (item.status === 'declined') this.fm.agentLog(id, 'error', `declined: $ ${truncate(item.command ?? '', 160)}`);
        else if (item.status === 'failed' || (item.exitCode ?? 0) !== 0) this.fm.agentLog(id, 'error', `exit ${item.exitCode ?? '?'}\n${tailLines(out, 8, 900) || '(no output)'}`);
        else this.fm.agentLog(id, 'result', tailLines(out, 8, 900) || '(no output)');
        break;
      }
      case 'fileChange': {
        const n = (item.changes ?? this.fileChanges.get(item.id) ?? []).length;
        if (item.status === 'completed') this.fm.agentLog(id, 'result', `applied ${n} file change${n === 1 ? '' : 's'}`);
        else this.fm.agentLog(id, 'error', `file change ${item.status ?? 'failed'}`);
        this.fileChanges.delete(item.id);
        break;
      }
      case 'dynamicToolCall': {
        const text = (item.contentItems ?? []).map((c) => c.text ?? '').filter(Boolean).join('\n');
        if (item.success === false || item.status === 'failed') this.fm.agentLog(id, 'error', truncate(text || 'tool error', 600));
        else this.fm.agentLog(id, 'result', headLines(text, 3, 300) || 'ok');
        break;
      }
      default:
        break;
    }
  }

  /** The turn ended: fill in the stats. */
  finish(turn: CodexTurn | undefined): TurnStats {
    const st = this.stats;
    st.numTurns = this.steps;
    if (!turn) {
      st.isError = true;
      st.subtype = 'error_no_result';
      st.errors.push('the turn ended without a result');
    } else {
      st.subtype = turn.status === 'completed' ? 'success' : `error_${turn.status}`;
      st.isError = turn.status !== 'completed';
      if (turn.error) {
        st.errors.push(turn.error.message);
        if (isAuthError(turn.error.codexErrorInfo, turn.error.message)) st.authFailed = firstLine(turn.error.message, 200);
        if (turn.error.codexErrorInfo === 'usageLimitExceeded') st.errors.push('ChatGPT usage limit reached');
      }
    }
    const tokens = this.tokens ? ` · ${this.tokens.toLocaleString('en-US')} tokens` : '';
    this.fm.agentLog(this.agentId, st.isError ? 'error' : 'result', `turn ${st.isError ? `ended: ${turn?.status ?? 'no result'}` : 'complete'} (${this.steps} steps${tokens})`);
    return st;
  }

  private diffLines(c: FileChange): string | undefined {
    if (!c.diff) return undefined;
    const file = relPath(path.isAbsolute(c.path) ? c.path : path.resolve(this.cwd, c.path), this.cwd);
    const lines = c.diff
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)\s/.test(l))
      .slice(0, 12)
      .map((l) => `${l[0]} ${l.slice(1)}`);
    return lines.length ? [file, ...lines].join('\n') : undefined;
  }
}
