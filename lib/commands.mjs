// The craft subcommands: doctor, setup and check, plus helpers that open reuses.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const claude = findClaude(process.env, process.platform, existsSync, home);
  const rules = [];
  for (const app of config.apps) {
    const exe = findExe(app);
    if (!exe) {
      log(`SKIP     ${app.label}: not installed (run doctor).`);
      continue;
    }
    const args = resolveArgs(app, workFolder);
    const addArgs = ['mcp', 'add', '--scope', 'user', app.name, '--', exe, ...args];
    if (dryRun) {
      log(`WOULD RUN  ${shellCommand([claude ?? 'claude', ...addArgs])}`);
    } else {
      runClaude(claude, ['mcp', 'remove', '--scope', 'user', app.name]); // fails harmlessly when not yet registered
      const run = runClaude(claude, addArgs);
      if (run.status !== 0) {
        log(`FAIL     ${app.label}: ${(run.stderr || run.stdout || run.error?.message || '').trim()}`);
        continue;
      }
      log(`ADDED    ${app.label} as "${app.name}"`);
    }
    rules.push(...(app.readOnlyTools ?? []).map((tool) => `mcp__${app.name}__${tool}`));
  }
  installSkill(config, { dryRun, log, home, workFolder });
  if (!allowRules || rules.length === 0) return rules;
  const settingsFile = join(home, '.claude', 'settings.json');
  if (dryRun) {
    log(`WOULD ALLOW in ${settingsFile}: ${rules.join(', ')}`);
    return rules;
  }
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  const { merged, added } = mergeAllowRules(settings, rules);
  if (added.length > 0) saveSettings(settingsFile, merged);
  log(`ALLOWED  ${added.length} new read-only tool rule(s) in ${settingsFile}; every other app tool still asks first.`);
  return rules;
}

// Copy skills/craft-apps into ~/.claude/skills, pointing it at this checkout and the work folder.
export function installSkill(config, { dryRun = false, log = console.log, home = homedir(), workFolder = expandHome(config.workFolder, home) } = {}) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const target = join(home, '.claude', 'skills', 'craft-apps', 'SKILL.md');
  if (dryRun) {
    log(`WOULD INSTALL the craft-apps skill at ${target}`);
    return;
  }
  const vars = { repo, workFolder, releaseOwner: config.releaseOwner ?? '<owner>' };
  // A Windows checkout with core.autocrlf has CRLF line endings, and the skill's front matter must start with "---\n".
  const text = readFileSync(join(repo, 'skills', 'craft-apps', 'SKILL.md'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{(repo|workFolder|releaseOwner)\}/g, (m, key) => vars[key]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  log(`SKILL    craft-apps installed at ${target}`);
}

// Replace settings.json through a temp file, keeping a backup. Windows refuses the rename (EPERM, EBUSY)
// while another program has the file open, so it is retried for about a second. On failure the temp file
// is removed and the old file stays.
export function saveSettings(settingsFile, settings, { attempts = 6, pauseMs = 200 } = {}) {
  const tmp = `${settingsFile}.tmp`;
  mkdirSync(dirname(settingsFile), { recursive: true });
  if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.craft-backup`);
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    for (let i = 1; ; i++) {
      try {
        renameSync(tmp, settingsFile);
        return;
      } catch (err) {
        if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
      }
    }
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* leave it; the message below still holds */ }
    throw new Error(
      `could not save the allow rules to ${settingsFile} (${err.code ?? err.message}). The servers are registered and ` +
        `${settingsFile} is unchanged, so every app tool will ask first. Another program probably had the file ` +
        `open: run setup again, or use --no-allow.`,
    );
  }
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
    if (app.args.some((a) => a.includes('{workFolder}')) && !existsSync(workFolder)) {
      failed++;
      log(`FAIL     ${app.label}: work folder ${workFolder} does not exist yet. Run setup first.`);
      continue;
    }
    const client = new McpClient(exe, resolveArgs(app, workFolder), { timeoutMs });
    try {
      const init = await client.initialize();
      const tools = await listTools(client);
      const names = new Set(tools.map((t) => t.name));
      const missing = [app.probe?.tool, ...(app.readOnlyTools ?? [])].filter((n) => n && !names.has(n));
      if (missing.length > 0) throw new Error(`craft-apps.json names tools this server lacks: ${missing.join(', ')}`);
      // A server that annotates a tool has the last word on whether it is read-only.
      const notReadOnly = (app.readOnlyTools ?? []).filter((n) => {
        const annotations = tools.find((t) => t.name === n).annotations;
        return annotations && annotations.readOnlyHint !== true;
      });
      if (notReadOnly.length > 0) throw new Error(`readOnlyTools lists tools the server does not mark read-only: ${notReadOnly.join(', ')}`);
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

export async function listTools(client) {
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

// Claude Code's native installer puts claude.exe in ~/.local/bin, which may not be on PATH.
// Returns null when only a shim such as claude.cmd could be on PATH; that needs a shell.
export function findClaude(env = process.env, platform = process.platform, exists = existsSync, home = homedir()) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const sep = platform === 'win32' ? '\\' : '/';
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  dirs.push([home, '.local', 'bin'].join(sep));
  return dirs.map((d) => [d, name].join(sep)).find((p) => exists(p)) ?? null;
}

export function runClaude(claude, args) {
  if (claude) return spawnSync(claude, args, { encoding: 'utf8', windowsHide: true });
  return spawnSync(shellCommand(['claude', ...args]), { shell: true, encoding: 'utf8' });
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
