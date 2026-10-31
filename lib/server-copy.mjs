// Claude Code keeps each app's server running for as long as a session is open, and Windows refuses to replace a
// running program, so a server started from the launcher's folder makes the launcher's updates fail with "Access is
// denied". Servers therefore run from a copy of the app's folder, which is made again whenever the launcher's CLI changes.
// run-server.mjs imports this file, and setup installs the two outside the checkout, so keep it free of other imports.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Left out of the copy: the window program (the server does not need it, and it is large), and portable mode's marker
// and data folder. Without them a copied server keeps its settings in the app's per-user folder, not in a copy that
// the next update deletes.
export function isCopied(name, isDirectory, exe) {
  const gui = basename(exe).replace(/-cli(\.exe)?$/i, '$1');
  if (name.toLowerCase() === gui.toLowerCase() || name.toLowerCase() === 'portable.txt') return false;
  return !(isDirectory && name.endsWith('Data'));
}

// The copy of the folder holding `exe`, made if this version has none yet. Returns the path of the copied CLI.
export function prepareCopy(exe, root) {
  const source = dirname(exe);
  const before = statSync(exe);
  const version = `${before.size}-${Math.trunc(before.mtimeMs)}`;
  const versions = join(root, 'servers', basename(exe).replace(/\.exe$/i, ''));
  const target = join(versions, version);
  const copied = join(target, basename(exe));
  if (!existsSync(copied)) {
    const tmp = `${target}.tmp-${process.pid}`;
    mkdirSync(versions, { recursive: true });
    try {
      cpSync(source, tmp, {
        recursive: true,
        filter: (from) => dirname(from) !== source || isCopied(basename(from), statSync(from).isDirectory(), exe),
      });
      const after = statSync(exe);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`${exe} changed while it was being copied`);
      // Rename last, so a folder with this name is always complete. Another session may have got there first.
      try {
        renameSync(tmp, target);
      } catch (err) {
        if (!existsSync(copied)) throw err;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  removeOldCopies(versions, version, basename(exe));
  return copied;
}

// A copy another open session is still running stays until a later start finds it free. Its CLI goes first: Windows
// refuses that while it runs, which leaves the rest of the folder intact for the running server.
export function removeOldCopies(versions, keep, exeName, { tmpAgeMs = 3600000, now = Date.now() } = {}) {
  for (const name of readdirSync(versions)) {
    if (name === keep) continue;
    const folder = join(versions, name);
    try {
      if (name.includes('.tmp-')) {
        if (now - statSync(folder).mtimeMs < tmpAgeMs) continue; // another session may be copying into it now
      } else {
        rmSync(join(folder, exeName), { force: true });
      }
      rmSync(folder, { recursive: true, force: true });
    } catch {
      // Still running; try again at the next start.
    }
  }
}
