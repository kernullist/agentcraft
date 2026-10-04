// Where connection secrets (API keys) live. A connection stores only a reference:
//
//   keyring:<id>   the OS credential store (Windows Credential Manager, macOS Keychain, Secret
//                  Service) via @napi-rs/keyring, under service "agentcraft"
//   env:<VAR>      an environment variable of the Foreman process
//
// Secrets are write-only from the outside: they enter through save(), are read only to build an
// agent's environment or test a connection, and are never sent to clients or logged; clients see
// mask() at most.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export interface SecretStore {
  /** "keyring" when the OS credential store works, "env-only" when it does not (env refs only) */
  readonly kind: 'keyring' | 'env-only' | 'memory';
  get(ref: string | undefined): string | undefined;
  /** store a secret for a connection; returns its reference */
  set(connectionId: string, value: string): string;
  delete(ref: string | undefined): void;
}

const SERVICE = 'agentcraft';

/** "sk-…a1b2": enough to recognise a key, useless to anyone else. */
export function mask(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}

function envRef(ref: string, env: NodeJS.ProcessEnv): string | undefined {
  const name = ref.slice('env:'.length);
  const v = env[name];
  return v && v.trim() ? v.trim() : undefined;
}

interface KeyringEntry {
  setPassword(v: string): void;
  getPassword(): string | null | undefined;
  deletePassword(): boolean | void;
}

type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

/**
 * Secrets in the OS credential store. The account name includes a hash of the AgentCraft home, so
 * two homes (e.g. a test home) never share a key under the same connection id.
 */
export class KeyringSecretStore implements SecretStore {
  readonly kind: 'keyring' | 'env-only';
  private readonly mod: KeyringModule | undefined;
  private readonly scope: string;

  constructor(
    home: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    this.scope = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12);
    let mod: KeyringModule | undefined;
    try {
      mod = createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
      // probe once: a missing Secret Service (headless Linux) fails here, not at the first save
      new mod.Entry(SERVICE, `probe@${this.scope}`).getPassword();
    } catch {
      mod = undefined;
    }
    this.mod = mod;
    this.kind = mod ? 'keyring' : 'env-only';
  }

  private entry(id: string): KeyringEntry {
    if (!this.mod) throw new Error('the OS credential store is not available here: use an environment variable (env:NAME) for the key');
    return new this.mod.Entry(SERVICE, `connection:${id}@${this.scope}`);
  }

  get(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    if (ref.startsWith('env:')) return envRef(ref, this.env);
    if (ref.startsWith('keyring:')) {
      try {
        return this.entry(ref.slice('keyring:'.length)).getPassword() ?? undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  set(connectionId: string, value: string): string {
    this.entry(connectionId).setPassword(value.trim());
    return `keyring:${connectionId}`;
  }

  delete(ref: string | undefined): void {
    if (!ref?.startsWith('keyring:') || !this.mod) return;
    try {
      this.entry(ref.slice('keyring:'.length)).deletePassword();
    } catch {
      /* already gone */
    }
  }
}

/** In-memory secrets (tests). */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  readonly values = new Map<string, string>();

  constructor(private env: NodeJS.ProcessEnv = {}) {}

  get(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    if (ref.startsWith('env:')) return envRef(ref, this.env);
    return this.values.get(ref);
  }

  set(connectionId: string, value: string): string {
    const ref = `keyring:${connectionId}`;
    this.values.set(ref, value.trim());
    return ref;
  }

  delete(ref: string | undefined): void {
    if (ref) this.values.delete(ref);
  }
}
