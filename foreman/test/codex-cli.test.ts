// Which Codex CLI the codex backend runs, and that the bundled (pinned) one really starts.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppServerClient, bundledCodex, resolveCodexCommand, versionFromUserAgent } from '../src/agents/codex/appserver.js';
import { readAccount } from '../src/agents/codex/auth.js';
import { rmrf, tempDir } from './helpers.js';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

describe('Codex CLI resolution', () => {
  it('bundles the exact @openai/codex version pinned in package.json', () => {
    const pinned = pkg.dependencies['@openai/codex']!;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/); // exact pin, no range: the protocol is tested against it
    const b = bundledCodex();
    expect(b?.version).toBe(pinned);
    expect(fs.existsSync(b!.js)).toBe(true);
  });

  it('prefers --codex-bin, then the bundled CLI, then PATH', () => {
    const bundled = { js: '/x/node_modules/@openai/codex/bin/codex.js', version: '1.2.3' };
    expect(resolveCodexCommand('/opt/codex', {}, bundled)).toEqual({ command: '/opt/codex', args: [], source: 'explicit' });
    expect(resolveCodexCommand('/y/codex.js', {}, bundled)).toEqual({ command: process.execPath, args: ['/y/codex.js'], source: 'explicit' });
    expect(resolveCodexCommand(undefined, {}, bundled)).toEqual({ command: process.execPath, args: [bundled.js], source: 'bundled' });
    expect(resolveCodexCommand(undefined, { PATH: '' }, null).source).toBe('path');
  });

  it('reads the CLI version from the initialize userAgent', () => {
    expect(versionFromUserAgent('agentcraft_foreman/0.147.0 (Windows 10.0.26200; x86_64) xterm')).toBe('0.147.0');
    expect(versionFromUserAgent('fake-codex/0.0.0')).toBe('0.0.0');
    expect(versionFromUserAgent(undefined)).toBeUndefined();
  });
});

describe('bundled Codex CLI smoke test', () => {
  const home = tempDir('ac-codex-home-');
  afterAll(() => rmrf(home));

  it('starts app-server, initializes and reports no account in a fresh CODEX_HOME', async () => {
    const client = new AppServerClient({ cmd: resolveCodexCommand(undefined, process.env), env: { ...process.env, CODEX_HOME: home } });
    try {
      const init = await client.initialize('agentcraft_test', '0.0.0');
      expect(versionFromUserAgent(init.userAgent)).toBe(bundledCodex()!.version);
      expect(fs.realpathSync(init.codexHome!)).toBe(fs.realpathSync(home));
      expect(await readAccount(client)).toBeNull();
    } finally {
      const exited = await client.close(3000);
      if (!exited) client.child.kill();
    }
  }, 60_000);
});
