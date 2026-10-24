// update: compare each installed app with its latest GitHub release, and install newer Windows releases for
// this user, with no admin prompt. Each version is unpacked into its own folder, and
// %LOCALAPPDATA%\Programs\<App> is a junction to the current one: swapping a junction needs no admin rights
// and works while the old version is still running (Claude sessions keep <app>-cli.exe open).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findExe } from './config.mjs';

// "photocraft-cli 0.12.0 (6a2d027ee, 2026-10-21)" or "v0.15.1" -> "0.12.0" / "0.15.1".
export function parseVersion(text) {
  return /\d+\.\d+\.\d+/.exec(text ?? '')?.[0] ?? null;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// SHA256SUMS.txt lines: "<64 hex>  <file name>" (a leading * marks binary mode in some tools).
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

export function releaseRepo(config, app) {
  return app.repo ?? (config.releaseOwner && `${config.releaseOwner}/${app.name}`);
}

export function installedVersion(exe) {
  const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return run.status === 0 ? parseVersion(run.stdout) : null;
}

export async function latestRelease(repo, fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'craft-integration' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  const release = await res.json();
  return { version: parseVersion(release.tag_name), assets: release.assets ?? [] };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, file, fetchFn) {
  const res = await fetchFn(url, { headers: { 'user-agent': 'craft-integration' } });
  if (!res.ok) throw new Error(`download answered ${res.status}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(file));
  return hash.digest('hex');
}

// Windows 10 and later ship bsdtar, which reads zip files.
function untar(zip, dir) {
  const run = spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`could not unpack ${zip}: ${(run.stderr || run.error?.message || '').trim()}`);
}

// Point `link` at `target`, replacing an earlier junction. A real folder in its place is never touched.
export function swapJunction(link, target) {
  let stat = null;
  try {
    stat = lstatSync(link);
  } catch {
    /* no link yet */
  }
  if (stat && !stat.isSymbolicLink()) throw new Error(`${link} is a real folder, not a junction made by update; move it away first`);
  if (stat) rmSync(link);
  symlinkSync(target, link, 'junction');
}

// Delete this app's unpacked versions other than `keep`. One still in use is left for the next run.
function pruneVersions(versions, app, keep) {
  for (const name of readdirSync(versions)) {
    if (!name.startsWith(`${app.name}-`) || join(versions, name) === keep) continue;
    try {
      rmSync(join(versions, name), { recursive: true, force: true });
    } catch {
      /* still running; removed by a later update */
    }
  }
}

// Without `install`, only reports. Returns how many apps failed to update.
export async function update(config, {
  install = false,
  only = [],
  log = console.log,
  fetchFn = fetch,
  base = process.env.LOCALAPPDATA ?? join(homedir(), '.local'),
  extract = untar,
  versionOf = installedVersion,
} = {}) {
  const apps = config.apps.filter((a) => only.length === 0 || only.includes(a.name));
  const unknown = only.filter((n) => !config.apps.some((a) => a.name === n));
  if (unknown.length > 0) throw new Error(`no such app in craft-apps.json: ${unknown.join(', ')}`);
  const downloads = join(base, 'craft', 'downloads');
  const versions = join(base, 'craft', 'apps');
  let failed = 0;
  let pending = 0;
  let moved = 0;
  for (const app of apps) {
    const repo = releaseRepo(config, app);
    const link = join(base, 'Programs', app.installDir ?? app.label);
    const perUser = join(link, `${app.exe}.exe`);
    const current = existsSync(perUser) ? perUser : findExe(app);
    if (!current || !repo) {
      log(`SKIP     ${app.label}: ${current ? 'no release repo in craft-apps.json' : 'not installed'}`);
      continue;
    }
    try {
      const have = versionOf(current);
      const latest = await latestRelease(repo, fetchFn);
      if (!have || !latest.version) throw new Error(`could not read a version (installed ${have}, latest ${latest.version})`);
      const behind = compareVersions(have, latest.version) < 0;
      if (!behind && current === perUser) {
        log(`CURRENT  ${app.label}: ${have}`);
        continue;
      }
      pending++;
      const zipName = `${app.name}-${latest.version}-windows-x64-portable.zip`;
      const zip = latest.assets.find((a) => a.name === zipName);
      const sums = latest.assets.find((a) => a.name === 'SHA256SUMS.txt');
      const size = zip ? ` (${Math.round(zip.size / 1048576)} MB)` : '';
      const why = behind ? `${have} -> ${latest.version}` : `${have}, only installed for all users (${current})`;
      if (!install) {
        log(`PENDING  ${app.label}: ${why}; ${zipName}${size} from github.com/${repo}`);
        continue;
      }
      if (!zip || !sums) throw new Error(`release ${latest.version} has no ${zip ? 'SHA256SUMS.txt' : zipName}`);
      const sumsRes = await fetchFn(sums.browser_download_url, { headers: { 'user-agent': 'craft-integration' } });
      const expected = parseSums(await sumsRes.text()).get(zipName);
      if (!expected) throw new Error(`SHA256SUMS.txt does not list ${zipName}`);
      mkdirSync(downloads, { recursive: true });
      const file = join(downloads, zipName);
      // A verified download from an interrupted run is reused; a partial one fails the hash and is fetched again.
      const kept = existsSync(file) && (await hashFile(file)) === expected;
      const actual = kept ? expected : await download(zip.browser_download_url, file, fetchFn);
      if (actual !== expected) {
        rmSync(file, { force: true });
        throw new Error(`checksum mismatch for ${zipName}; the file was deleted and nothing was installed`);
      }
      // Unpack beside the versions, check the new CLI runs and reports the release, then switch the junction.
      const staging = join(versions, `.staging-${app.name}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      extract(file, staging);
      const top = readdirSync(staging);
      const unpacked = top.length === 1 ? join(staging, top[0]) : staging;
      const newExe = join(unpacked, `${app.exe}.exe`);
      if (!existsSync(newExe)) throw new Error(`${zipName} has no ${app.exe}.exe`);
      const got = versionOf(newExe);
      if (got !== latest.version) throw new Error(`the unpacked ${app.exe} reports ${got}, not ${latest.version}`);
      const target = join(versions, `${app.name}-${latest.version}`);
      rmSync(target, { recursive: true, force: true });
      renameSync(unpacked, target);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(join(base, 'Programs'), { recursive: true });
      swapJunction(link, target);
      rmSync(file, { force: true });
      pruneVersions(versions, app, target);
      log(`UPDATED  ${app.label}: ${why}; now ${latest.version} in ${link} (SHA-256 verified)`);
      if (resolve(current) !== resolve(perUser)) moved++;
    } catch (err) {
      failed++;
      log(`FAIL     ${app.label}: ${err.message}`);
    }
  }
  if (!install) log(pending === 0 ? 'All apps are current.' : `${pending} app(s) to install. Run: node craft.mjs update`);
  if (moved > 0) {
    log(`NOTE     ${moved} app(s) now run from %LOCALAPPDATA%\\Programs. Run setup so Claude uses them, then uninstall the ` +
      'old all-users copies in Settings > Apps (that asks for admin once; later updates never do).');
  }
  return failed;
}
