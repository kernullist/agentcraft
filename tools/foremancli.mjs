#!/usr/bin/env node
// Foreman CLI for scripts and QA: connects like the mod does (hello -> snapshot), prints JSON.
//
//   node tools/foremancli.mjs status [--wait-showcase SECONDS]   backend/auth + agents/tasks/decisions summary
//   node tools/foremancli.mjs wait [--timeout SECONDS]           wait until the Foreman answers
//   node tools/foremancli.mjs diff <repoId> <worktree>           structured diff stats (diff.request)
//   node tools/foremancli.mjs diff --decision d3                 the diff of a merge decision
//   node tools/foremancli.mjs repo-add <path>                    register a repo (repo.add)
//   node tools/foremancli.mjs send <type> '<json payload>'       any client message; prints the ack
//   node tools/foremancli.mjs send user.message to=kit "text=hello there"   (same, key=value form)
//   node tools/foremancli.mjs connections                         list connections (keys masked)
//   node tools/foremancli.mjs connection-setup --provider deepseek [--role all|lead|workers]
//        [--name N] [--lead-model M] [--worker-model M] [--key-stdin | --key-env VAR] [--rekey]
//        reuse (test) or create a connection and assign it. The key is read from stdin only (never
//        from the command line, where other processes could see it). Exit 3: a key is needed or
//        was rejected (the result says why).
//
// Options: --port N (default AGENTCRAFT_PORT or 7878), --timeout SECONDS (connect, default 15),
// --full (diff: print every file/hunk instead of a summary). Exit 0 when ok, 1 on error.

import { ForemanClient, DEFAULT_FOREMAN_PORT } from './lib/foremanclient.mjs';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (['port', 'timeout', 'wait-showcase', 'decision', 'provider', 'role', 'name', 'lead-model', 'worker-model', 'key-env'].includes(key)) flags[key] = argv[++i];
    else flags[key] = true;
  } else pos.push(a);
}
const cmd = pos.shift();
if (!cmd || flags.help) {
  console.error('usage: node tools/foremancli.mjs status|wait|diff|send [args] [--port N] [--timeout S] [--wait-showcase S] [--json]');
  process.exit(cmd ? 0 : 2);
}
const port = flags.port ? Number(flags.port) : DEFAULT_FOREMAN_PORT;
const connectMs = (flags.timeout ? Number(flags.timeout) : cmd === 'wait' ? 120 : 15) * 1000;
const out = (o) => console.log(JSON.stringify(o, null, 2));

/** The API key piped on stdin (one line, trimmed). */
async function readStdinKey() {
  if (process.stdin.isTTY) throw new Error('--key-stdin: pipe the key on stdin');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const key = data.split(/\r?\n/)[0].trim();
  if (!key) throw new Error('--key-stdin: no key on stdin');
  return key;
}

const view = (c) => (c ? { id: c.id, name: c.name, provider: c.provider, auth: c.auth, message: c.message, secret: c.secret, roles: c.roles } : null);

let fm;
try {
  fm = await ForemanClient.connect({
    port,
    timeoutMs: connectMs,
    client: 'cli',
    onWait: (ms) => process.stderr.write(`[foremancli] waiting for the Foreman on :${port} (${Math.round(ms / 1000)}s)...\n`),
  });
} catch (e) {
  out({ ok: false, error: e.message });
  process.exit(1);
}

let res;
try {
  switch (cmd) {
    case 'wait':
    case 'status': {
      if (flags['wait-showcase']) {
        await fm.waitForState((s) => s.foreman?.showcase === true, {
          timeoutMs: Number(flags['wait-showcase']) * 1000,
          what: 'the showcase hold (foreman.status.showcase)',
        });
      }
      if (cmd === 'status') {
        // a Foreman that just started is still checking Claude access ("auth unknown/checking"):
        // give that a few seconds so launch.ps1's banner shows the real result
        await fm
          .waitForState((s) => !['unknown', 'checking'].includes(s.foreman?.auth), { timeoutMs: 15_000, what: 'the auth check' })
          .catch(() => undefined);
      }
      res = { ok: true, ...fm.summary() };
      break;
    }
    case 'diff': {
      let repoId = pos[0];
      let worktree = pos[1];
      if (flags.decision) {
        const d = fm.state.decisions.get(flags.decision);
        if (!d) throw new Error(`no decision ${flags.decision}`);
        if (!d.repoId || !d.worktree) throw new Error(`decision ${d.id} (${d.kind}) has no repoId/worktree`);
        repoId = d.repoId;
        worktree = d.worktree;
      }
      if (!repoId || !worktree) throw new Error('usage: diff <repoId> <worktree> | diff --decision <id>');
      const d = await fm.diff(repoId, worktree);
      res = flags.full
        ? { ok: true, ...d }
        : {
            ok: true,
            repoId: d.repoId,
            worktree: d.worktree,
            base: d.base,
            branch: d.branch,
            stats: d.stats,
            truncated: d.truncated,
            files: d.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, hunks: f.hunks.length })),
          };
      break;
    }
    case 'repo-add': {
      if (!pos[0]) throw new Error('usage: repo-add <path>');
      const ack = await fm.send('repo.add', { path: pos.join(' ') });
      res = { ok: true, ack };
      break;
    }
    case 'send': {
      const type = pos[0];
      if (!type) throw new Error("usage: send <type> '<json payload>'");
      // payload: one JSON object, or key=value pairs (values parsed as JSON when they can be:
      // numbers, true/false; otherwise strings). key=value survives PowerShell 5.1's argument
      // quoting, which strips the double quotes inside a JSON argument.
      let payload = {};
      const rest = pos.slice(1);
      if (rest.length && rest[0].trim().startsWith('{')) payload = JSON.parse(rest.join(' '));
      else {
        for (const kv of rest) {
          const i = kv.indexOf('=');
          if (i <= 0) throw new Error(`expected key=value, got "${kv}"`);
          const k = kv.slice(0, i);
          const v = kv.slice(i + 1);
          try { payload[k] = /^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? JSON.parse(v) : v; } catch { payload[k] = v; }
        }
      }
      const ack = await fm.send(type, payload);
      res = { ok: true, ack };
      break;
    }
    case 'connections': {
      if (!fm.state.snapshot?.connections) throw new Error(`this Foreman (${fm.state.foreman?.backend ?? '?'}) has no connections: they need --backend claude or codex`);
      res = { ok: true, connections: [...fm.state.connections.values()].map(view) };
      break;
    }
    case 'connection-setup': {
      if (!fm.state.snapshot?.connections) throw new Error(`this Foreman (${fm.state.foreman?.backend ?? '?'}) has no connections: they need --backend claude or codex`);
      const provider = flags.provider;
      if (!provider) throw new Error('--provider is required (e.g. deepseek)');
      const role = flags.role ?? 'all';
      if (!['all', 'lead', 'workers'].includes(role)) throw new Error('--role must be all, lead or workers');
      const key = flags['key-stdin'] ? await readStdinKey() : undefined;
      const all = [...fm.state.connections.values()].filter((c) => c.provider === provider && c.source === 'user');
      let conn = all.find((c) => c.id === provider) ?? all[0];
      const models = { ...(flags['lead-model'] ? { lead: flags['lead-model'] } : {}), ...(flags['worker-model'] ? { worker: flags['worker-model'] } : {}) };
      const changes = key || flags['key-env'] || flags.name || Object.keys(models).length;
      if (!conn || changes || flags.rekey) {
        if (!conn && !key && !flags['key-env']) {
          res = { ok: false, needKey: true, error: `no ${provider} connection yet: give the API key (--key-stdin or --key-env)` };
          break;
        }
        if (flags.rekey && !key && !flags['key-env']) {
          res = { ok: false, needKey: true, error: '--rekey needs a new key (--key-stdin or --key-env)' };
          break;
        }
        // the Foreman saves it (key to the OS credential store) and tests it right away
        const ack = await fm.send(
          'connection.save',
          {
            connection: {
              provider,
              ...(conn ? { id: conn.id } : {}),
              ...(flags.name ? { name: flags.name } : {}),
              ...(key ? { apiKey: key } : {}),
              ...(flags['key-env'] ? { apiKeyEnv: flags['key-env'] } : {}),
              ...(Object.keys(models).length ? { models } : {}),
            },
          },
          { timeoutMs: 30_000 },
        );
        conn = ack.result?.connection ?? conn;
      } else {
        const ack = await fm.send('connection.test', { connectionId: conn.id }, { timeoutMs: 30_000 });
        conn = ack.result?.connection ?? conn;
      }
      if (conn?.auth !== 'ok') {
        res = { ok: false, needKey: true, connection: view(conn), error: conn?.message ?? `${provider} is not working` };
        break;
      }
      const assigned = await fm.send('connection.assign', { connectionId: conn.id, role }, { timeoutMs: 30_000 });
      res = { ok: true, connection: view(fm.state.connections.get(conn.id) ?? conn), assignment: assigned.result };
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
} catch (e) {
  res = { ok: false, error: e.message };
}
fm.close();
out(res);
process.exit(res.ok ? 0 : res.needKey ? 3 : 1);
