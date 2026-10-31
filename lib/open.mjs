// open: start an app's window on its own control port, check that its MCP server can attach, and register
// that server with Claude Code as "<app>-live". Most apps' attach mode exits when no window is open, so the
// live entry is only added once a window answers.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHome, fillArgs, findExe, liveVars, serverCommand, stateDir } from './config.mjs';
import { findClaude, installedRunner, installRunner, listTools, mergeAllowRules, prepareServer, registerServer, saveSettings } from './commands.mjs';
import { McpClient } from './mcp-client.mjs';

export { fillArgs };

// The window program sits beside the CLI: C:\Program Files\WordCraft\wordcraft-cli.exe -> wordcraft.exe.
export function guiPath(cliExe, app) {
  const ext = cliExe.toLowerCase().endsWith('.exe') ? '.exe' : '';
  return join(dirname(cliExe), `${app.exe.replace(/-cli$/, '')}${ext}`);
}

export function portAnswers(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function waitForPort(port, timeoutMs, pollMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portAnswers(port)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export async function open(config, name, file, {
  log = console.log,
  home = homedir(),
  waitMs = 60000,
  timeoutMs = 20000,
  register = true,
  launch = (exe, args) => spawn(exe, args, { detached: true, stdio: 'ignore' }).unref(),
} = {}) {
  const app = config.apps.find((a) => a.name === name);
  if (!app) throw new Error(`no such app in craft-apps.json: ${name}`);
  if (!app.live) throw new Error(`${app.label} has no "live" entry: its MCP server cannot attach to a window`);
  const cli = findExe(app);
  if (!cli) throw new Error(`${app.label} is not installed (run doctor)`);
  const workFolder = expandHome(config.workFolder, home);
  mkdirSync(workFolder, { recursive: true });
  mkdirSync(stateDir(process.env, home), { recursive: true });
  const vars = liveVars(app, workFolder, process.env, home);

  if (await portAnswers(app.live.port)) {
    log(`RUNNING  ${app.label}: something already answers on port ${app.live.port}; using it.`);
    if (file) log(`NOTE     ${basename(file)} was not opened; open it from Claude with the live tools.`);
  } else {
    const gui = app.live.gui ? expandHome(app.live.gui, home) : guiPath(cli, app);
    if (!existsSync(gui)) throw new Error(`window program not found: ${gui}`);
    if (file && !existsSync(resolve(file))) throw new Error(`no such file: ${resolve(file)}`);
    launch(gui, [...fillArgs(app.live.guiArgs, vars), ...(file ? [resolve(file)] : [])]);
    log(`STARTED  ${app.label}: ${gui} on control port ${app.live.port}`);
    if (!(await waitForPort(app.live.port, waitMs))) {
      throw new Error(`the ${app.label} window did not open control port ${app.live.port} within ${waitMs / 1000} s`);
    }
  }

  // Attach the way Claude will, and make the same harmless call check makes.
  const attach = fillArgs(app.live.attach, vars);
  const client = new McpClient(cli, attach, { timeoutMs });
  let tools;
  try {
    await client.initialize();
    tools = await listTools(client);
    if (app.probe) {
      const result = await client.request('tools/call', { name: app.probe.tool, arguments: app.probe.arguments ?? {} });
      if (result?.isError) throw new Error(`${app.probe.tool} returned an error: ${(result.content ?? []).map((c) => c.text).join(' ').slice(0, 300)}`);
    }
  } finally {
    await client.close();
  }
  log(`ATTACHED ${app.label}: ${tools.length} tools through ${attach.join(' ')}`);
  if (!register) return tools;

  const liveName = `${app.name}-live`;
  const claude = findClaude(process.env, process.platform, existsSync, home);
  const server = serverCommand(app, cli, attach, installedRunner());
  if (server.command !== cli) {
    installRunner();
    prepareServer(server, cli, app.label, log);
  }
  const added = registerServer(claude, liveName, server);
  if (added.status !== 0) throw new Error(`claude mcp add failed: ${(added.stderr || added.stdout || added.error?.message || '').trim()}`);
  log(`ADDED    ${liveName}. Start a new Claude Code session to use it; it works while this window is open.`);

  // Same read-only rules as headless, for the tools the window's server offers and marks read-only.
  const rules = (app.readOnlyTools ?? [])
    .filter((n) => tools.some((t) => t.name === n && t.annotations?.readOnlyHint !== false))
    .map((n) => `mcp__${liveName}__${n}`);
  const settingsFile = join(home, '.claude', 'settings.json');
  try {
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    const { merged, added: newRules } = mergeAllowRules(settings, rules);
    if (newRules.length > 0) saveSettings(settingsFile, merged);
    log(`ALLOWED  ${newRules.length} new read-only rule(s) for ${liveName}; every other tool asks first.`);
  } catch (err) {
    log(`NOTE     ${err.message}`);
  }
  return tools;
}
