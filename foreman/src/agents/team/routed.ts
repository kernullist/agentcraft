// A team backend whose lead and workers each run on an assigned connection (connections/). Every
// turn is routed to the runtime runner of its role's connection (Claude Agent SDK or codex
// app-server), so one team can mix them (e.g. lead on Claude, workers on DeepSeek), and the
// assignment can change while the Foreman runs: it applies from the next turn (a job whose session
// ran on another connection starts a new session; TeamBackend.runJob).
//
// Auth is per connection: a failed worker connection blocks the workers only. The Foreman status
// (banner) is the assigned connections' status: one connection -> exactly its status.
import type { ConnectionsApi, Foreman } from '../../foreman.js';
import { ClientError } from '../../foreman.js';
import { ConnectionManager, type ConnectionView } from '../../connections/manager.js';
import { modelFor as connModel, provider } from '../../connections/providers.js';
import type { ConnectionInput } from '../../connections/store.js';
import { ConnectionError } from '../../connections/store.js';
import { CLI_CONNECTION_ID, type Assignment, type Connection, type ConnectionStatus, type RuntimeId } from '../../connections/types.js';
import { TeamBackend, type GateResult, type Role, type TeamConfig, type TurnSpec, type TurnStats } from './backend.js';
import type { ToolHooks, TurnHandle } from './tools.js';

/** What a runtime runner may use of the backend. */
export interface RunnerHost {
  readonly fm: Foreman;
  readonly hooks: ToolHooks;
  gate(agentId: string, role: Role, cwd: string, turn: TurnHandle, signal: AbortSignal, toolName: string, input: Record<string, unknown>, title?: string): Promise<GateResult>;
  recordSession(key: string, sessionId: string, model: string, stats?: TurnStats): void;
}

export interface AuthReport {
  auth: ConnectionStatus['auth'];
  message?: string;
  account?: string;
  models?: string[];
}

/** One agent runtime: checks a connection and runs turns on it. */
export interface RuntimeRunner {
  readonly runtime: RuntimeId;
  /**
   * Check (or sign in to) a connection. `report` may be called several times (a device code
   * first, then ok). Resolves once the result is known or, for a sign-in waiting on the user,
   * soon (the sign-in continues and reports later).
   */
  check(conn: Connection, secret: string | undefined, report: (r: AuthReport) => void): Promise<void>;
  runTurn(spec: TurnSpec, conn: Connection, secret: string | undefined): Promise<TurnStats>;
  authFailureMessage(conn: Connection, detail: string, thrown: boolean): string;
  stop?(): void;
}

const AUTH_RANK: Record<ConnectionStatus['auth'], number> = { ok: 0, unknown: 1, checking: 2, failed: 3 };

export interface RoutedBackendOptions {
  name: 'claude' | 'codex';
  /** product name for messages; default: the lead connection's name */
  label?: string;
  connections: ConnectionManager;
  runners: (host: RunnerHost) => Partial<Record<RuntimeId, RuntimeRunner>>;
}

export class RoutedBackend extends TeamBackend {
  readonly name: 'claude' | 'codex';
  readonly connections: ConnectionManager;
  private readonly runners: Partial<Record<RuntimeId, RuntimeRunner>>;
  private readonly fixedLabel: string | undefined;

  constructor(fm: Foreman, cfg: TeamConfig, opts: RoutedBackendOptions) {
    super(fm, cfg);
    this.name = opts.name;
    this.fixedLabel = opts.label;
    this.connections = opts.connections;
    const host: RunnerHost = {
      fm,
      hooks: this.hooks,
      gate: (...a) => this.gate(...a),
      recordSession: (...a) => this.recordSession(...a),
    };
    this.runners = opts.runners(host);
    this.connections.onStatus((id, prev, next) => this.onConnectionStatus(id, prev, next));
  }

  protected get label(): string {
    return this.fixedLabel ?? this.connections.connectionFor('lead').name;
  }

  private runner(c: Connection): RuntimeRunner {
    const rt = provider(c.provider).runtime;
    const r = this.runners[rt];
    if (!r) throw new ConnectionError(`${c.name} needs the ${rt} runtime, which this Foreman does not run`);
    return r;
  }

  private assigned(): Connection[] {
    const a = this.connections.assignment();
    return [...new Set([a.lead, a.workers])].map((id) => this.connections.require(id));
  }

  // ---- TeamBackend hooks ---------------------------------------------------------------------

  protected modelFor(role: Role): string {
    const c = this.connections.connectionFor(role);
    return connModel(c, role, this.connections.statusOf(c.id).models) ?? (provider(c.provider).runtime === 'codex' ? 'codex default' : 'default');
  }

  protected authFailureMessage(detail: string, thrown: boolean): string {
    const c = this.connections.connectionFor('lead');
    return this.runner(c).authFailureMessage(c, detail, thrown);
  }

  protected override onAuthFailure(role: Role, detail: string, thrown: boolean): void {
    const c = this.connections.connectionFor(role);
    this.connections.setStatus(c.id, { auth: 'failed', message: this.runner(c).authFailureMessage(c, detail, thrown) });
  }

  protected override unavailable(role: Role): string | undefined {
    const c = this.connections.connectionFor(role);
    const st = this.connections.statusOf(c.id);
    if (st.auth === 'ok') return undefined;
    return st.message ?? (st.auth === 'checking' ? `checking ${c.name}...` : `${c.name} is not checked yet`);
  }

  protected override sessionTag(role: Role): string | undefined {
    const id = this.connections.connectionFor(role).id;
    return id === CLI_CONNECTION_ID ? undefined : id;
  }

  protected runTurn(spec: TurnSpec): Promise<TurnStats> {
    const c = this.connections.connectionFor(spec.role);
    return this.runner(c).runTurn(spec, c, this.connections.secretOf(c));
  }

  /** Check every assigned connection; true when all of them are ok. */
  async checkAuth(): Promise<boolean> {
    await Promise.all(this.assigned().map((c) => this.check(c.id)));
    this.refreshStatus();
    return this.assigned().every((c) => this.connections.statusOf(c.id).auth === 'ok');
  }

  /** Check (or sign in to) one connection. */
  async check(id: string): Promise<ConnectionStatus> {
    const c = this.connections.require(id);
    let runner: RuntimeRunner;
    try {
      runner = this.runner(c);
    } catch (e) {
      this.connections.setStatus(id, { auth: 'failed', message: (e as Error).message });
      return this.connections.statusOf(id);
    }
    try {
      await runner.check(c, this.connections.secretOf(c), (r) => this.connections.setStatus(id, { ...r, ...(r.auth !== 'ok' && !r.account ? { account: undefined } : {}) }));
    } catch (e) {
      this.connections.setStatus(id, { auth: 'failed', message: `${c.name}: ${(e as Error).message}` });
    }
    return this.connections.statusOf(id);
  }

  override async stop(): Promise<void> {
    for (const r of Object.values(this.runners)) r?.stop?.();
    await super.stop();
  }

  // ---- status ------------------------------------------------------------------------------

  private onConnectionStatus(id: string, prev: ConnectionStatus, next: ConnectionStatus): void {
    const a = this.connections.assignment();
    const inUse = a.lead === id || a.workers === id;
    if (inUse && next.auth === 'failed' && (prev.auth !== 'failed' || prev.message !== next.message) && next.message) {
      // loud, like a backend auth failure: the team cannot work on this connection
      this.fm.log.error(next.message);
      this.fm.bus.feed('error', next.message);
      this.fm.notify('warn', next.message);
      if (process.stdout.isTTY) process.stdout.write('\x07');
    }
    if (inUse && next.auth === 'ok' && prev.auth !== 'ok') {
      this.fm.log.info(`${this.connections.require(id).name}: ok${next.account ? ` (${next.account})` : ''}`);
      this.tick();
    }
    if (inUse) this.refreshStatus();
  }

  /** The banner: one connection -> its status; two -> the worse auth and both messages. */
  refreshStatus(): void {
    const a = this.connections.assignment();
    const lead = this.connections.statusOf(a.lead);
    if (a.lead === a.workers) {
      this.fm.setStatus({ auth: lead.auth, message: lead.message, account: lead.account });
      return;
    }
    const workers = this.connections.statusOf(a.workers);
    const L = this.connections.require(a.lead);
    const W = this.connections.require(a.workers);
    const auth = AUTH_RANK[workers.auth] > AUTH_RANK[lead.auth] ? workers.auth : lead.auth;
    const bad = [lead.auth !== 'ok' ? lead.message : undefined, workers.auth !== 'ok' ? workers.message : undefined].filter((m): m is string => !!m);
    const message = bad.length ? bad.join(' | ') : `lead: ${lead.message ?? L.name} · workers: ${workers.message ?? W.name}`;
    const account = [lead.account, workers.account].filter(Boolean).join(' | ') || undefined;
    this.fm.setStatus({ auth, message, account });
  }

  // ---- client API (protocol connection.*) ---------------------------------------------------

  readonly connectionsApi: ConnectionsApi = {
    views: () => this.connections.views(),
    providers: () => ConnectionManager.providers(),
    secretStore: () => this.connections.store.secretKind,
    onEvent: (fn) => this.connections.onEvent(fn),
    save: (input) => this.saveConnection(input),
    remove: (id) => this.deleteConnection(id),
    test: (id) => this.testConnection(id),
    assign: (role, id) => this.assignConnection(role, id),
  };

  views(): ConnectionView[] {
    return this.connections.views();
  }

  async saveConnection(input: ConnectionInput): Promise<ConnectionView> {
    const c = this.wrap(() => this.connections.save(input));
    // test it right away: the user wants to know whether the key works
    await this.check(c.id);
    if (this.assigned().some((x) => x.id === c.id)) this.refreshStatus();
    return this.connections.view(this.connections.require(c.id));
  }

  deleteConnection(id: string): Assignment {
    const a = this.wrap(() => this.connections.delete(id));
    this.afterAssignmentChange();
    return a;
  }

  async assignConnection(role: 'lead' | 'workers' | 'all', id: string): Promise<Assignment> {
    const c = this.wrap(() => this.connections.require(id));
    try {
      this.runner(c);
    } catch (e) {
      throw new ClientError((e as Error).message);
    }
    const a = this.wrap(() => this.connections.assign(role, id));
    this.fm.bus.feed('system', `${role === 'all' ? 'The team' : role === 'lead' ? 'Marlow' : 'The workers'} now ${role === 'lead' ? 'uses' : 'use'} ${c.name} (from the next turn)`);
    if (this.connections.statusOf(id).auth !== 'ok') await this.check(id);
    this.afterAssignmentChange();
    return a;
  }

  async testConnection(id: string): Promise<ConnectionView> {
    this.wrap(() => this.connections.require(id));
    await this.check(id);
    return this.connections.view(this.connections.require(id));
  }

  private afterAssignmentChange(): void {
    this.refreshStatus();
    this.tick();
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ConnectionError) throw new ClientError(e.message);
      throw e;
    }
  }
}
