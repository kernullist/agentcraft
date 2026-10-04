// The connections a Foreman can use, and which one the lead and the workers use.
//
//   <home>/connections.json   saved connections (no secrets: only references) + an assignment
//                             per profile
//   "cli" connection          derived from --backend / env / config.json at start, never saved:
//                             without any saved assignment the whole team uses it, so every
//                             existing way of starting the Foreman keeps working unchanged
//
// Flags (--connection, --lead-connection, --worker-connection) override the saved assignment for
// this run only.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.js';
import { slugify } from '../util/text.js';
import { isProviderId, provider } from './providers.js';
import type { SecretStore } from './secrets.js';
import { CLI_CONNECTION_ID, type Assignment, type Connection, type ProviderId } from './types.js';

interface FileShape {
  version: 1;
  connections: Array<Omit<Connection, 'source'>>;
  assignments: Record<string, Assignment>;
}

/** What a client may send to create or change a connection (the secret is write-only). */
export interface ConnectionInput {
  id?: string;
  name?: string;
  provider: ProviderId;
  baseUrl?: string;
  /** a new API key (stored in the OS credential store) */
  apiKey?: string;
  /** or: take the key from this environment variable of the Foreman */
  apiKeyEnv?: string;
  models?: { lead?: string; worker?: string };
  effort?: string;
}

export class ConnectionError extends Error {}

export class ConnectionStore {
  private readonly file: string | undefined;
  private data: FileShape;
  private readonly home: string;
  private readonly profile: string;
  private readonly cli: Connection | undefined;
  private readonly secrets: SecretStore;
  private readonly forced: Partial<Assignment>;
  private readonly now: () => number;

  constructor(opts: {
    home: string;
    profile: string;
    /** the connection derived from flags/env (never saved) */
    cli?: Connection;
    secrets: SecretStore;
    /** --connection / --lead-connection / --worker-connection for this run */
    forced?: Partial<Assignment>;
    /** false: in memory only (single-connection backends, tests) */
    persist?: boolean;
    now?: () => number;
  }) {
    this.home = opts.home;
    this.profile = opts.profile;
    this.cli = opts.cli;
    this.secrets = opts.secrets;
    this.forced = opts.forced ?? {};
    this.now = opts.now ?? Date.now;
    const forced = this.forced;
    this.file = opts.persist === false ? undefined : path.join(opts.home, 'connections.json');
    const raw = this.file ? readJson<Partial<FileShape>>(this.file) : undefined;
    this.data = { version: 1, connections: Array.isArray(raw?.connections) ? raw!.connections.filter((c) => c && isProviderId(c.provider)) : [], assignments: raw?.assignments ?? {} };
    for (const [role, id] of Object.entries(forced)) {
      if (id && !this.get(id)) throw new ConnectionError(`--${role === 'lead' ? 'lead-' : role === 'workers' ? 'worker-' : ''}connection: no connection "${id}" (saved: ${this.list().map((c) => c.id).join(', ') || 'none'})`);
    }
  }

  get secretKind(): SecretStore['kind'] {
    return this.secrets.kind;
  }

  list(): Connection[] {
    return [...(this.cli ? [this.cli] : []), ...this.data.connections.map((c) => ({ ...c, source: 'user' as const }))];
  }

  get(id: string): Connection | undefined {
    return this.list().find((c) => c.id === id);
  }

  require(id: string): Connection {
    const c = this.get(id);
    if (!c) throw new ConnectionError(`no connection "${id}"`);
    return c;
  }

  /** The key of a connection (to build an agent environment or test it). Never sent to clients. */
  secretOf(c: Connection): string | undefined {
    return this.secrets.get(c.secretRef);
  }

  /** Who uses what: flags for this run > the saved assignment of this profile > the cli connection. */
  assignment(): Assignment {
    const saved = this.data.assignments[this.profile];
    const fallback = this.cli?.id ?? this.data.connections[0]?.id ?? CLI_CONNECTION_ID;
    const pick = (id: string | undefined) => (id && this.get(id) ? id : undefined);
    return {
      lead: pick(this.forced.lead) ?? pick(saved?.lead) ?? fallback,
      workers: pick(this.forced.workers) ?? pick(saved?.workers) ?? fallback,
    };
  }

  assign(role: 'lead' | 'workers' | 'all', id: string): Assignment {
    this.require(id);
    const cur = this.assignment();
    const next: Assignment = { lead: role === 'workers' ? cur.lead : id, workers: role === 'lead' ? cur.workers : id };
    this.data.assignments[this.profile] = next;
    // a flag-forced role stays forced for this run; the saved choice applies next time
    this.write();
    return this.assignment();
  }

  save(input: ConnectionInput): Connection {
    if (!isProviderId(input.provider)) throw new ConnectionError(`unknown provider "${String(input.provider)}"`);
    const p = provider(input.provider);
    if (!p.userCreatable) throw new ConnectionError(`${p.label} connections come from the command line, not the connection list`);
    if (input.id === CLI_CONNECTION_ID) throw new ConnectionError('the command-line connection cannot be edited; add a new one');
    const existing = input.id ? this.data.connections.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) throw new ConnectionError(`no connection "${input.id}"`);
    if (existing && existing.provider !== input.provider) throw new ConnectionError('the provider of a connection cannot change; add a new one');

    const baseUrl = input.baseUrl?.trim() || undefined;
    if (p.fields.some((f) => f.key === 'baseUrl' && f.required) && !baseUrl && !existing?.baseUrl) throw new ConnectionError(`${p.label} needs a base URL`);
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ConnectionError('the base URL must start with http:// or https://');
    if (baseUrl && /^http:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl)) {
      throw new ConnectionError('a remote endpoint must use https:// (the API key would travel in clear text)');
    }
    const effortField = p.fields.find((f) => f.key === 'effort');
    if (input.effort && !effortField?.choices?.includes(input.effort)) throw new ConnectionError(`effort must be one of ${effortField?.choices?.join(', ') ?? '(none for this provider)'}`);
    if (input.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv)) throw new ConnectionError('apiKeyEnv must be an environment variable name');

    const id = existing?.id ?? this.newId(input.name ?? p.label);
    let secretRef = existing?.secretRef;
    if (p.needsSecret) {
      if (input.apiKey?.trim()) {
        if (/\s/.test(input.apiKey.trim())) throw new ConnectionError('the API key contains spaces');
        secretRef = this.secrets.set(id, input.apiKey);
      } else if (input.apiKeyEnv) {
        if (secretRef?.startsWith('keyring:')) this.secrets.delete(secretRef);
        secretRef = `env:${input.apiKeyEnv}`;
      }
      if (!secretRef) throw new ConnectionError(`${p.label} needs an API key`);
    }
    const models = { ...(existing?.models ?? {}), ...cleanModels(input.models) };
    const conn: Omit<Connection, 'source'> = {
      id,
      name: (input.name?.trim() || existing?.name || p.label).slice(0, 40),
      provider: p.id,
      ...(baseUrl ? { baseUrl } : existing?.baseUrl ? { baseUrl: existing.baseUrl } : {}),
      ...(secretRef ? { secretRef } : {}),
      ...(Object.keys(models).length ? { models } : {}),
      ...(input.effort ? { effort: input.effort } : existing?.effort ? { effort: existing.effort } : {}),
      ...(p.id === 'chatgpt' ? { codexHome: existing?.codexHome ?? path.join(this.home, 'codex', id) } : {}),
      createdAt: existing?.createdAt ?? this.now(),
    };
    if (existing) Object.assign(existing, conn);
    else this.data.connections.push(conn);
    this.write();
    return { ...conn, source: 'user' };
  }

  delete(id: string): void {
    if (id === CLI_CONNECTION_ID) throw new ConnectionError('the command-line connection cannot be removed');
    const i = this.data.connections.findIndex((c) => c.id === id);
    if (i < 0) throw new ConnectionError(`no connection "${id}"`);
    const [c] = this.data.connections.splice(i, 1);
    this.secrets.delete(c!.secretRef);
    // every profile that used it falls back (to the cli connection) instead of pointing nowhere
    for (const [prof, a] of Object.entries(this.data.assignments)) {
      if (a.lead === id || a.workers === id) {
        const rest = { lead: a.lead === id ? undefined : a.lead, workers: a.workers === id ? undefined : a.workers };
        if (!rest.lead && !rest.workers) delete this.data.assignments[prof];
        else this.data.assignments[prof] = { lead: rest.lead ?? rest.workers!, workers: rest.workers ?? rest.lead! };
      }
    }
    this.write();
  }

  private newId(name: string): string {
    const base = slugify(name, 24) || 'connection';
    let id = base === CLI_CONNECTION_ID ? `${base}-1` : base;
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`;
    return id;
  }

  private write(): void {
    if (this.file) writeJsonAtomic(this.file, this.data);
  }
}

function cleanModels(m: ConnectionInput['models']): { lead?: string; worker?: string } {
  const out: { lead?: string; worker?: string } = {};
  for (const k of ['lead', 'worker'] as const) {
    const v = m?.[k]?.trim();
    if (v === undefined) continue;
    if (v && !/^[A-Za-z0-9._:/@-]{1,100}$/.test(v)) throw new ConnectionError(`bad ${k} model "${v}"`);
    if (v) out[k] = v;
  }
  return out;
}
