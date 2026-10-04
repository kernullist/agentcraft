// Live connection state for a running Foreman: the saved/derived connections (store.ts), each
// one's auth status, and change events for the protocol (connection.upsert / connection.remove).
// Testing and signing in need a runtime, so they live in the team backend (agents/team/routed.ts).
import { mask } from './secrets.js';
import { provider, PROVIDERS, type ProviderField } from './providers.js';
import type { ConnectionInput, ConnectionStore } from './store.js';
import type { Assignment, Connection, ConnectionStatus, ProviderId, Role, RuntimeId } from './types.js';

/** A connection as clients see it: never the secret, at most its masked form. */
export interface ConnectionView {
  id: string;
  name: string;
  provider: ProviderId;
  providerLabel: string;
  runtime: RuntimeId;
  source: 'cli' | 'user';
  baseUrl?: string;
  /** "sk-…a1b2" (OS credential store) or "env:NAME" */
  secret?: string;
  models?: { lead?: string; worker?: string };
  effort?: string;
  dataDestination: string;
  personalUse: boolean;
  auth: ConnectionStatus['auth'];
  message?: string;
  account?: string;
  availableModels?: string[];
  roles: Array<'lead' | 'workers'>;
}

export interface ProviderView {
  id: ProviderId;
  label: string;
  runtime: RuntimeId;
  summary: string;
  dataDestination: string;
  personalUse: boolean;
  fields: ProviderField[];
}

export type ConnectionEvent = { type: 'upsert'; view: ConnectionView } | { type: 'remove'; id: string } | { type: 'assign'; assignment: Assignment };

export class ConnectionManager {
  private statuses = new Map<string, ConnectionStatus>();
  private listeners: Array<(e: ConnectionEvent) => void> = [];
  private statusListeners: Array<(id: string, prev: ConnectionStatus, next: ConnectionStatus) => void> = [];

  constructor(readonly store: ConnectionStore) {}

  onEvent(fn: (e: ConnectionEvent) => void): void {
    this.listeners.push(fn);
  }

  onStatus(fn: (id: string, prev: ConnectionStatus, next: ConnectionStatus) => void): void {
    this.statusListeners.push(fn);
  }

  private emit(e: ConnectionEvent): void {
    for (const l of this.listeners) l(e);
  }

  list(): Connection[] {
    return this.store.list();
  }

  require(id: string): Connection {
    return this.store.require(id);
  }

  assignment(): Assignment {
    return this.store.assignment();
  }

  connectionFor(role: Role): Connection {
    const a = this.store.assignment();
    return this.store.require(role === 'lead' ? a.lead : a.workers);
  }

  secretOf(c: Connection): string | undefined {
    return this.store.secretOf(c);
  }

  statusOf(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? { auth: 'unknown' };
  }

  setStatus(id: string, patch: Partial<ConnectionStatus>): void {
    if (!this.store.get(id)) return;
    const prev = this.statusOf(id);
    const next: ConnectionStatus = { ...prev, ...patch, checkedAt: Date.now() };
    for (const k of Object.keys(next) as Array<keyof ConnectionStatus>) if (next[k] === undefined) delete next[k];
    this.statuses.set(id, next);
    for (const l of this.statusListeners) l(id, prev, next);
    this.emit({ type: 'upsert', view: this.view(this.store.require(id)) });
  }

  save(input: ConnectionInput): Connection {
    const c = this.store.save(input);
    // a changed key/endpoint/model must be checked again before it runs anything
    this.statuses.set(c.id, { auth: 'unknown' });
    this.emit({ type: 'upsert', view: this.view(c) });
    return c;
  }

  delete(id: string): Assignment {
    const before = this.store.assignment();
    this.store.delete(id);
    this.statuses.delete(id);
    this.emit({ type: 'remove', id });
    const after = this.store.assignment();
    if (after.lead !== before.lead || after.workers !== before.workers) this.emitAssignment(before, after);
    return after;
  }

  assign(role: 'lead' | 'workers' | 'all', id: string): Assignment {
    const before = this.store.assignment();
    const after = this.store.assign(role, id);
    this.emitAssignment(before, after);
    return after;
  }

  private emitAssignment(before: Assignment, after: Assignment): void {
    this.emit({ type: 'assign', assignment: after });
    // the role badges of every connection that gained or lost a role
    for (const id of new Set([before.lead, before.workers, after.lead, after.workers])) {
      const c = this.store.get(id);
      if (c) this.emit({ type: 'upsert', view: this.view(c) });
    }
  }

  view(c: Connection): ConnectionView {
    const p = provider(c.provider);
    const st = this.statusOf(c.id);
    const a = this.store.assignment();
    const secret = c.secretRef?.startsWith('env:') ? c.secretRef : mask(this.store.secretOf(c));
    return {
      id: c.id,
      name: c.name,
      provider: c.provider,
      providerLabel: p.label,
      runtime: p.runtime,
      source: c.source,
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : p.defaultBaseUrl ? { baseUrl: p.defaultBaseUrl } : {}),
      ...(secret ? { secret } : {}),
      ...(c.models && Object.keys(c.models).length ? { models: { ...c.models } } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
      dataDestination: p.dataDestination,
      personalUse: p.personalUse,
      auth: st.auth,
      ...(st.message ? { message: st.message } : {}),
      ...(st.account ? { account: st.account } : {}),
      ...(st.models?.length ? { availableModels: [...st.models] } : {}),
      roles: [...(a.lead === c.id ? (['lead'] as const) : []), ...(a.workers === c.id ? (['workers'] as const) : [])],
    };
  }

  views(): ConnectionView[] {
    return this.list().map((c) => this.view(c));
  }

  static providers(): ProviderView[] {
    return Object.values(PROVIDERS)
      .filter((p) => p.userCreatable)
      .map((p) => ({ id: p.id, label: p.label, runtime: p.runtime, summary: p.summary, dataDestination: p.dataDestination, personalUse: p.personalUse, fields: p.fields.map((f) => ({ ...f })) }));
  }
}
