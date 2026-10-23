// The craft subcommands: doctor, setup and check.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandHome, findExe, resolveArgs } from './config.mjs';
import { McpClient } from './mcp-client.mjs';

// doctor: which apps are installed, where, and which version.
export function doctor(config, log = console.log) {
  let found = 0;
  for (const app of config.apps) {
    const exe = findExe(app);
    if (!exe) {
      log(`MISSING  ${app.label}: ${app.exe} not found. Install it, or set "path" for it in craft-apps.json.`);
      continue;
    }
    const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const version = run.status === 0 ? run.stdout.trim() : `could not run --version (${run.error?.message ?? `exit ${run.status}`})`;
    log(`FOUND    ${app.label}: ${exe} | ${version}`);
    found++;
  }
  log(`${found} of ${config.apps.length} apps found.`);
  return found;
}

// setup: register every installed app with Claude Code (user scope) and allow its read-only tools.
export function setup(config, { dryRun = false, allowRules = true, log = console.log, home = homedir() } = {}) {
  const workFolder = expandHome(config.workFolder, home);
  if (!dryRun && !existsSync(workFolder)) mkdirSync(workFolder, { recursive: true });
  const rules = [];
  for (const app of config.apps) {
    const exe = findExe(app);
    if (!exe) {
      log(`SKIP     ${app.label}: not installed (run doctor).`);
      continue;
    }
    const args = resolveArgs(app, workFolder);
    const add = shellCommand(['claude', 'mcp', 'add', '--scope', 'user', app.name, '--', exe, ...args]);
    const remove = shellCommand(['claude', 'mcp', 'remove', '--scope', 'user', app.name]);
    if (dryRun) {
      log(`WOULD RUN  ${add}`);
    } else {
      spawnSync(remove, { shell: true, stdio: 'ignore' }); // fails harmlessly when not yet registered
      const run = spawnSync(add, { shell: true, encoding: 'utf8' });
      if (run.status !== 0) {
        log(`FAIL     ${app.label}: ${(run.stderr || run.stdout || run.error?.message || '').trim()}`);
        continue;
      }
      log(`ADDED    ${app.label} as "${app.name}"`);
    }
    rules.push(...(app.readOnlyTools ?? []).map((tool) => `mcp__${app.name}__${tool}`));
  }
  if (!allowRules || rules.length === 0) return rules;
  const settingsFile = join(home, '.claude', 'settings.json');
  if (dryRun) {
    log(`WOULD ALLOW in ${settingsFile}: ${rules.join(', ')}`);
    return rules;
  }
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  const { merged, added } = mergeAllowRules(settings, rules);
  if (added.length > 0) {
    mkdirSync(dirname(settingsFile), { recursive: true });
    if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.craft-backup`);
    writeFileSync(`${settingsFile}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(`${settingsFile}.tmp`, settingsFile);
  }
  log(`ALLOWED  ${added.length} new read-only tool rule(s) in ${settingsFile}; every other app tool still asks first.`);
  return rules;
}

// check: start each installed server, list its tools, and make one harmless call.
export async function check(config, { log = console.log, timeoutMs = 20000, home = homedir() } = {}) {
  const workFolder = expandHome(config.workFolder, home);
  let failed = 0;
  for (const app of config.apps) {
    const exe = findExe(app);
    if (!exe) {
      log(`SKIP     ${app.label}: not installed`);
      continue;
    }
    const client = new McpClient(exe, resolveArgs(app, workFolder), { timeoutMs });
    try {
      const init = await client.initialize();
      const tools = await listTools(client);
      const names = new Set(tools.map((t) => t.name));
      const missing = [app.probe?.tool, ...(app.readOnlyTools ?? [])].filter((n) => n && !names.has(n));
      if (missing.length > 0) throw new Error(`craft-apps.json names tools this server lacks: ${missing.join(', ')}`);
      if (app.probe) {
        const result = await client.request('tools/call', { name: app.probe.tool, arguments: app.probe.arguments ?? {} });
        if (result?.isError) throw new Error(`${app.probe.tool} returned an error: ${textOf(result)}`);
      }
      log(`PASS     ${app.label}: ${init?.serverInfo?.name ?? 'server'} ${init?.serverInfo?.version ?? ''}, ${tools.length} tools`);
    } catch (err) {
      failed++;
      log(`FAIL     ${app.label}: ${err.message}`);
    } finally {
      await client.close();
    }
  }
  return failed;
}

async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.request('tools/list', cursor ? { cursor } : {});
    tools.push(...(page?.tools ?? []));
    cursor = page?.nextCursor;
  } while (cursor);
  return tools;
}

function textOf(result) {
  return (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 300);
}

export function mergeAllowRules(settings, rules) {
  const merged = structuredClone(settings);
  merged.permissions ??= {};
  merged.permissions.allow ??= [];
  const added = rules.filter((r) => !merged.permissions.allow.includes(r));
  merged.permissions.allow.push(...added);
  return { merged, added };
}

// One command line for the platform shell. `claude` is a .cmd shim on Windows, so it needs a shell.
export function shellCommand(parts, platform = process.platform) {
  return parts.map((p) => quote(p, platform)).join(' ');
}

function quote(arg, platform) {
  if (platform === 'win32') {
    if (/["%^&|<>]/.test(arg)) throw new Error(`argument cannot be passed safely through cmd.exe: ${arg}`);
    return /[\s]/.test(arg) ? `"${arg}"` : arg;
  }
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
