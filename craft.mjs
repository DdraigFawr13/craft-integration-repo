#!/usr/bin/env node
// craft: register the craft apps' own MCP servers with Claude Code and check that they answer.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { check, doctor, setup } from './lib/commands.mjs';
import { update } from './lib/update.mjs';

const USAGE = `Usage: node craft.mjs <command> [options]

  doctor              List which craft apps are installed and where.
  setup [--dry-run]   Register each installed app with Claude Code (user scope)
        [--no-allow]  and allow its read-only tools. --dry-run only prints.
  check               Start each app's MCP server, list its tools, make one harmless call.
  update --check      Compare each installed app with its latest GitHub release.
  update [APP…]       Download each newer Windows installer, verify its SHA-256, install it,
                      then run check on the updated apps.

  --config FILE       Use another app list (default: craft-apps.json next to this script).
`;

async function main(argv) {
  const [command, ...rest] = argv;
  const configIndex = rest.indexOf('--config');
  const configFile = configIndex >= 0 ? rest[configIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), 'craft-apps.json');
  if (!configFile) throw new Error('--config needs a file');
  switch (command) {
    case 'doctor':
      doctor(loadConfig(configFile));
      return 0;
    case 'setup':
      setup(loadConfig(configFile), { dryRun: rest.includes('--dry-run'), allowRules: !rest.includes('--no-allow') });
      return 0;
    case 'check':
      return (await check(loadConfig(configFile))) === 0 ? 0 : 1;
    case 'update': {
      const config = loadConfig(configFile);
      const only = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--config');
      if (rest.includes('--check')) return (await update(config, { only })) === 0 ? 0 : 1;
      const failed = await update(config, { install: true, only });
      const checked = await check({ ...config, apps: config.apps.filter((a) => only.length === 0 || only.includes(a.name)) });
      return failed + checked === 0 ? 0 : 1;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`craft: ${err.message}\n`);
    process.exit(1);
  },
);
