# Craft integration

Lets Claude Code on your desktop use the installed craft apps as tools. Each app already ships its own
MCP server inside its `-cli` program (`wordcraft-cli mcp` and so on). This repo does not replace those
servers; it finds them, registers them with Claude Code, and checks that they answer.

First apps: PhotoCraft, LightCraft and WordCraft. More are added by appending to `craft-apps.json`.

## Use it

Needs Node 20 or newer, Claude Code's `claude` command on PATH, and the apps installed from their release
installers, which put `<app>-cli.exe` in `C:\Program Files\<App>\`.

```sh
node craft.mjs doctor            # which apps are installed, where, which version
node craft.mjs setup --dry-run   # show what setup would do
node craft.mjs setup             # register them with Claude Code
node craft.mjs check             # start each server, list its tools, make one harmless call
```

Then restart Claude Code and run `/mcp` to see the servers.

`setup` does three things, and nothing else:

1. Creates the work folder (`~/CraftWork` by default) if it is missing.
2. Runs `claude mcp add --scope user <app> -- <path to app-cli> <args>` for each installed app, replacing an
   earlier entry of the same name.
3. Adds `mcp__<app>__<tool>` rules to `permissions.allow` in `~/.claude/settings.json` for the tools listed
   under `readOnlyTools`, so Claude can look without asking. Every other tool (open, save, export, run a
   command) still asks you first. The previous file is kept as `settings.json.craft-backup`.
   `--no-allow` skips this step.

## The app list

`craft-apps.json` holds one entry per app:

| Field | Meaning |
| --- | --- |
| `name` | The server name in Claude Code, and the middle part of its tool names |
| `exe`, `installDir` | The CLI program and the installer's folder under Program Files |
| `path` | Optional: the full path to the CLI, when it is somewhere else |
| `args` | How to start the server. `{workFolder}` is replaced by the work folder |
| `probe` | The harmless call `check` makes |
| `readOnlyTools` | Tools allowed without asking. `check` fails if a name here is not offered by the server |

What each app is started with, and why:

| App | Args | Why |
| --- | --- | --- |
| PhotoCraft | `mcp --automation-read-root W --automation-write-root W` | PhotoCraft refuses all file access without roots. Paths are relative to the work folder |
| LightCraft | `mcp --compact` | Leaves out ~90 one-tool-per-command entries; `run_command` still reaches them. No `--library`, so it never locks your real library |
| WordCraft | `mcp` | Headless document session |

All three run headless (no window). Driving the open app window comes in a later phase (`craft open`).

## Safety

- PhotoCraft can only read and write inside the work folder. LightCraft and WordCraft can reach any file
  your account can, so their save, export and import tools always ask before running.
- LightCraft's `render_photo` is not on the allow list because it can write to a path.

## Develop

```sh
npm test    # or: node --test test/craft.test.mjs
```

The tests use a stand-in server (`test/fixtures/fake-server.mjs`); no app needs to be installed.
