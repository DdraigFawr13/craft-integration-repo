// Reads craft-apps.json and resolves each app's paths for this computer.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export function loadConfig(file) {
  // Notepad and PowerShell on Windows may save UTF-8 with a byte order mark, which JSON.parse rejects.
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error(`${file}: "apps" must be a non-empty list`);
  }
  for (const app of config.apps) {
    for (const key of ['name', 'label', 'exe', 'args']) {
      if (!app[key]) throw new Error(`${file}: an app is missing "${key}"`);
    }
    if (!/^[a-z0-9-]+$/.test(app.name)) {
      throw new Error(`${file}: app name "${app.name}" may use only a-z, 0-9 and -`);
    }
  }
  return config;
}

export function expandHome(path, home = homedir()) {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path;
}

// The app's args with {workFolder} filled in.
export function resolveArgs(app, workFolder) {
  return app.args.map((arg) => arg.replaceAll('{workFolder}', workFolder));
}

// Fill {port}, {tokenFile} and {workFolder} in a list of arguments.
export function fillArgs(args, vars) {
  return args.map((arg) => arg.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m)));
}

// Where craft keeps its own files on this computer: tokens, the server starter and the servers' copies.
export function stateDir(env = process.env, home = homedir()) {
  return join(env.LOCALAPPDATA ?? join(home, '.cache'), 'craft');
}

// The live entry's values for fillArgs.
export function liveVars(app, workFolder, env = process.env, home = homedir()) {
  return { port: app.live.port, tokenFile: join(stateDir(env, home), `${app.name}.token`), workFolder };
}

// Where the launcher installs and updates the CLI on Windows: a portable install goes to
// %LOCALAPPDATA%\ArtCraft Launcher\apps\<app> (no admin), an MSI install to Program Files\<App>.
function launcherPaths(app, env, platform) {
  if (platform !== 'win32') return [];
  const exe = `${app.exe}.exe`;
  const paths = [];
  if (env.LOCALAPPDATA) paths.push([env.LOCALAPPDATA, 'ArtCraft Launcher', 'apps', app.name, exe].join('\\'));
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root && app.installDir) paths.push([root, app.installDir, exe].join('\\'));
  }
  return paths;
}

// The launcher's places, then PATH. `app.path` in the config wins.
export function candidatePaths(app, env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? `${app.exe}.exe` : app.exe;
  const sep = platform === 'win32' ? '\\' : '/';
  const paths = [];
  if (app.path) paths.push(expandHome(app.path));
  paths.push(...launcherPaths(app, env, platform));
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (dir) paths.push([dir, exe].join(sep));
  }
  return paths;
}

export function findExe(app, env = process.env, platform = process.platform, exists = existsSync) {
  return candidatePaths(app, env, platform).find((p) => exists(p)) ?? null;
}

// How to start a server. A launcher install goes through `runner`, so that a running server does not block the
// launcher's updates. Anything else starts as it is: the launcher does not replace it, and other platforms can
// replace a running program.
export function serverCommand(app, exe, args, runner, env = process.env, platform = process.platform) {
  if (!launcherPaths(app, env, platform).includes(exe)) return { command: exe, args };
  return { command: process.execPath, args: [runner, exe, ...args] };
}
