---
name: craft-apps
description: Use when the user wants something made, edited, inspected or converted with the craft apps (PhotoCraft, LightCraft, WordCraft, PdfCraft, DesignCraft, GridCraft, DeckCraft, CADCraft, VectorCraft, SoundCraft, FilmCraft, EffectCraft, FigCraft, SolidCraft): pictures, photos, documents, PDFs, page layouts, spreadsheets, slides, drawings, vector art, audio, video, motion graphics, interface designs or 3D CAD parts, through the mcp__<app>__ or mcp__<app>-live__ tools.
---

# Working in the craft apps

Each craft app runs its own MCP server. Two kinds are registered:

- `<app>`: a headless session with no window. It is always available. Use it unless the user wants to watch.
- `<app>-live`: drives the app's open window. It exists only after `node craft.mjs open <app>` and a new session.

This skill holds no facts about any app. They live in two places; read them, don't guess:

- `{repo}/craft-apps.json`: each app's `use` (what it is for), `guide` (its agent guide), the tools allowed without
  asking (`readOnlyTools`), and how it is started (`args`, `live`).
- The app's guide: `https://github.com/{releaseOwner}/<app>/blob/main/<guide>`, or `guide` itself when it is a full URL.

## Steps

1. **Pick the app** from the `use` lines in `craft-apps.json`. If two fit (a photo: PhotoCraft or LightCraft), say
   which you chose and why in one line.
2. **Read the app's guide** before its first tool call in a session. It names the tools, the common recipes and the
   traps. A guide that disagrees with the tool list is out of date: the server's own tool list and `list_commands`
   (or `command_list`) win.
3. **Find commands, don't guess them.** Most work goes through a run-any-command tool. Look the id up with the
   list tool's `filter` first and read its `params` doc. Send several steps in one batch call where the app has one.
4. **Keep files in the work folder** (`{workFolder}`). Copy inputs there, save results under new names, and never
   save over the user's original. In the apps not confined to it (see the README's Safety section), say the full
   path before any save or export.
5. **Look at the result before calling it done.** After a visible change, call the app's render, preview or
   screenshot tool and look at the image. Fix what is wrong, then render again. Report what you saw, not what
   you sent.
6. **Show the user.** Export a PNG (or the format they asked for) into the work folder, and send or link it.

## Ask first

- Saving over a file that already exists, or deleting anything.
- Running scripts (PDF JavaScript, app scripting) or raw control-channel calls.
- Anything outside the work folder.

The read-only tools in `readOnlyTools` already run without asking. Every other tool shows a permission prompt.

## When a call fails

- **"automation path rejected: absolute paths must be inside the automation root"** (PhotoCraft's wording; other
  apps word it their own way): the app is confined to `{workFolder}`. Copy the file there.
- **The app is not reachable** on an `-live` tool: its window is closed. Ask the user to run
  `node craft.mjs open <app>`, or use the headless `<app>` tools instead.
- **A tool the guide names is missing:** the installed version differs from the guide's. Run
  `node {repo}/craft.mjs doctor` for the installed versions; the ArtCraft Launcher shows and installs updates.
