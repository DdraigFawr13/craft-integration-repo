# Craft integration

Lets Claude Code on your desktop use the installed craft apps as tools. Each app already ships its own
MCP server inside its `-cli` program (`wordcraft-cli mcp` and so on). This repo does not replace those
servers; it finds them, registers them with Claude Code, and checks that they answer.

All fourteen local craft apps are listed: PhotoCraft, LightCraft, WordCraft, PdfCraft, DesignCraft, GridCraft,
DeckCraft, CADCraft, VectorCraft, SoundCraft, FilmCraft, EffectCraft, FigCraft and SolidCraft. More are added by appending to
`craft-apps.json`.

## Use it

Needs Node 20 or newer, Claude Code (found on PATH or in `~/.local/bin`, where its installer puts it), and the
apps, installed with the [ArtCraft Launcher](https://github.com/storytold/craft-launcher). Its portable installs
(`%LOCALAPPDATA%\ArtCraft Launcher\apps\<app>\`) are found first, then its MSI installs (`C:\Program Files\<App>\`).

```sh
node craft.mjs doctor            # which apps are installed, where, which version
node craft.mjs setup --dry-run   # show what setup would do
node craft.mjs setup             # register them with Claude Code
node craft.mjs check             # start each server, list its tools, make one harmless call
```

Then restart Claude Code and run `/mcp` to see the servers.

`setup` does four things, and nothing else:

1. Creates the work folder (`~/CraftWork` by default) if it is missing.
2. Runs `claude mcp add --scope user <app> -- <path to app-cli> <args>` for each installed app, replacing an
   earlier entry of the same name.
3. Installs the `craft-apps` skill at `~/.claude/skills/craft-apps/SKILL.md` (see below), replacing an earlier copy.
4. Adds `mcp__<app>__<tool>` rules to `permissions.allow` in `~/.claude/settings.json` for the tools listed
   under `readOnlyTools`, so Claude can look without asking. Every other tool (open, save, export, run a
   command) still asks you first. The previous file is kept as `settings.json.craft-backup`.
   `--no-allow` skips this step. Windows refuses to replace the file while another program has it open, so
   the save is retried for about a second. If it still fails, the servers stay registered, the old file is
   kept, and `setup` says so: run it again.

## Keep the apps updated

The ArtCraft Launcher does this; this repo does not install anything. In the launcher's settings, turn on
**Automatically download and install updates** (off by default). Updates keep the format each app was installed
with:

- **Portable (.zip)**: installs for your account, so updates need no admin prompt and run unattended.
- **Installer (.msi)**: installs for all users, so Windows asks for admin on every update.

To move an app from MSI to portable, uninstall it in the launcher, then install it again as Portable. After the
launcher updates or moves an app, run `node craft.mjs check`. It shows a FAIL if a release renamed or
re-annotated a tool on the allow list. If the app's folder changed (MSI to portable), run `setup` as well.

## The app list

`craft-apps.json` holds one entry per app:

| Field | Meaning |
| --- | --- |
| `name` | The server name in Claude Code, and the middle part of its tool names |
| `use` | One line on what the app is for. The skill picks the app from these |
| `guide` | The app's agent guide, as a path in its repo (`github.com/<releaseOwner>/<app>`), or a full URL for an app hosted elsewhere (SolidCraft is `tangency-labs/solidcraft`) |
| `exe`, `installDir` | The CLI program and the installer's folder under Program Files |
| `path` | Optional: the full path to the CLI, when it is somewhere else |
| `args` | How to start the server. `{workFolder}` is replaced by the work folder |
| `probe` | The harmless call `check` makes |
| `readOnlyTools` | Tools allowed without asking. `check` fails if a name here is not offered by the server, or if the server annotates it and does not mark it read-only |
| `live` | Optional: how `open` starts the app's window and attaches to it (see below) |

What each app is started with, and why (W is the work folder):

| App | Args | Why |
| --- | --- | --- |
| PhotoCraft, WordCraft, DesignCraft, DeckCraft, SoundCraft, EffectCraft, FigCraft | `mcp --automation-read-root W --automation-write-root W` | Every file the app's tools read or write must be inside the work folder |
| PdfCraft | `mcp --compact` + the two roots | `--compact` lists a core set plus `tool_search` and `tool_call` instead of ~120 task tools |
| VectorCraft | `mcp --headless` + the two roots | Without `--headless` it attaches to whatever app answers on port 7979 |
| LightCraft | `mcp --compact` | Leaves out ~90 one-tool-per-command entries; `run_command` still reaches them. No `--library`, so it never locks your real library |
| SolidCraft | `mcp --headless --allow-path W` | Without `--headless` it attaches to a running SolidCraft window. `--allow-path` adds the work folder to the folders its tools may reach |
| GridCraft, CADCraft, FilmCraft | `mcp` | Headless session. These have no root flags yet |

All run headless (no window). To watch Claude work, use `open` (below).

## Watch Claude work in a window

```sh
node craft.mjs open wordcraft                       # start WordCraft's window
node craft.mjs open photocraft ~/CraftWork/a.jpg    # start it with a file
```

`open` starts the app's window on its own control port (`live.port`: 18001 PhotoCraft to 18011 EffectCraft,
18012 SolidCraft, so two open apps never share a port). It waits for the port, attaches the way Claude will and makes the probe
call, then registers `<app>-live` with Claude Code. Start a new Claude Code session to use the live tools;
they work while that window is open. If something already answers on the port, `open` uses it.

The live entry is added only by `open`, not by `setup`. Seven apps' attach mode exits when no window is
open, and Claude Code starts every registered server when a session begins. To drop one:
`claude mcp remove --scope user wordcraft-live`.

| `live` field | Meaning |
| --- | --- |
| `port` | The control port for this app's window |
| `guiArgs` | How the window is started. `{port}`, `{tokenFile}` and `{workFolder}` are filled in |
| `attach` | How the MCP server attaches to the window |
| `gui` | Optional: the window program, when it is not `<app>.exe` beside the CLI |

- **PdfCraft** has no `live` entry: its `mcp` server cannot attach to a window.
- **PhotoCraft's** control port needs a token. The window and the server share
  `%LOCALAPPDATA%\craft\photocraft.token`, which the window creates on first use.
- **PhotoCraft and VectorCraft** windows get the work-folder roots, because those windows enforce them. Every
  other window can reach any file your account can, so in live mode their open, save and export tools
  always ask first.

## The craft-apps skill

`skills/craft-apps/SKILL.md` tells Claude how to work in the apps:

- pick the app from the `use` lines
- read that app's own agent guide before its first call
- look command ids up instead of guessing them
- keep files in the work folder and never save over an original
- render the result and look at it before reporting
- ask before overwriting, deleting, running scripts or leaving the work folder

It holds no facts about any app. Those stay in `craft-apps.json` and in each app's guide, so they can't go stale
in a second copy. `setup` fills in this checkout's path, the work folder and the release owner when it installs
the skill.

No storytold craft app ships a skill of its own; I searched the twelve repos then known. Each app does ship an agent guide, and the
skill points to it. SolidCraft bundles four skill documents of its own (modeling, mechanisms, editing, checking), read
through its `skill_reference` tool; its guide says when. The layout follows the `artcraft-mcp` skill, without its copied tool lists.

## Safety

- Nine apps can only read and write inside the work folder. LightCraft, GridCraft, CADCraft and FilmCraft
  can reach any file your account can, so their open, save, export and import tools always ask first.
- SolidCraft reaches the work folder, plus the folder of a design it opened or saved when that folder is inside
  your home folder and not hidden. Its open, save, export, screenshot, execute and batch tools always ask first.
- The allow lists come from each server's own `readOnlyHint` annotations, minus tools that take a file path
  to write to: GridCraft's `screenshot`, CADCraft's `render`, SoundCraft's `screenshot`, FigCraft's `export` and
  LightCraft's `render_photo` always ask. CADCraft and SoundCraft do not annotate their tools, so their lists
  were picked by reading the tool descriptions.

## Develop

```sh
npm test    # or: node --test test/craft.test.mjs
```

The tests use a stand-in server (`test/fixtures/fake-server.mjs`); no app needs to be installed.

## Licence

MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`), the same as the craft apps.
