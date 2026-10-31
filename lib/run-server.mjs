#!/usr/bin/env node
// What Claude Code starts for a launcher-installed app: run-server.mjs <path to app-cli> <args>. It runs the server from
// a current copy (see server-copy.mjs). The server talks to Claude Code directly over the inherited stdin and stdout.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareCopy } from './server-copy.mjs';

const [exe, ...args] = process.argv.slice(2);
let command = exe;
try {
  command = prepareCopy(exe, join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'craft'));
} catch (err) {
  process.stderr.write(`craft: no copy of ${exe} (${err.message}). Running it in place, which blocks updates while it runs.\n`);
}

const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
child.on('error', (err) => {
  process.stderr.write(`craft: could not start ${command}: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
