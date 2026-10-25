#!/usr/bin/env node
// craft: register the craft apps' own MCP servers with Claude Code and check that they answer.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { check, doctor, setup } from './lib/commands.mjs';

const USAGE = `Usage: node craft.mjs <command> [options]

  doctor              List which craft apps are installed and where.
  setup [--dry-run]   Register each installed app with Claude Code (user scope)
        [--no-allow]  and allow its read-only tools. --dry-run only prints.
  check               Start each app's MCP server, list its tools, make one harmless call.

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
