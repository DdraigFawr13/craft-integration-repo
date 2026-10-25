// update: compare each installed app with its latest GitHub release, and install newer Windows releases.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

function isRunning(app) {
  if (process.platform !== 'win32') return false;
  const run = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${app.name}.exe`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return run.stdout?.toLowerCase().includes(`${app.name}.exe`) ?? false;
}

const MSI_EXIT = {
  1602: ' (cancelled)',
  1618: ' (another installation is running; try again when it finishes)',
  1619: ' (Windows Installer could not open the package; if it repeats, run update from your own terminal)',
};

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

// Without `install`, only reports. Returns how many apps failed to update.
export async function update(config, {
  install = false,
  only = [],
  log = console.log,
  fetchFn = fetch,
  installMsi = runMsiexec,
  downloads = join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'craft', 'downloads'),
} = {}) {
  const apps = config.apps.filter((a) => only.length === 0 || only.includes(a.name));
  const unknown = only.filter((n) => !config.apps.some((a) => a.name === n));
  if (unknown.length > 0) throw new Error(`no such app in craft-apps.json: ${unknown.join(', ')}`);
  let failed = 0;
  let behind = 0;
  for (const app of apps) {
    const exe = findExe(app);
    const repo = releaseRepo(config, app);
    if (!exe || !repo) {
      log(`SKIP     ${app.label}: ${exe ? 'no release repo in craft-apps.json' : 'not installed'}`);
      continue;
    }
    try {
      const have = installedVersion(exe);
      const latest = await latestRelease(repo, fetchFn);
      if (!have || !latest.version) throw new Error(`could not read a version (installed ${have}, latest ${latest.version})`);
      if (compareVersions(have, latest.version) >= 0) {
        log(`CURRENT  ${app.label}: ${have}`);
        continue;
      }
      behind++;
      const msiName = `${app.name}-${latest.version}-windows-x64.msi`;
      const msi = latest.assets.find((a) => a.name === msiName);
      const sums = latest.assets.find((a) => a.name === 'SHA256SUMS.txt');
      const size = msi ? ` (${Math.round(msi.size / 1048576)} MB)` : '';
      if (!install) {
        log(`BEHIND   ${app.label}: ${have} -> ${latest.version}, ${msiName}${size} from github.com/${repo}`);
        continue;
      }
      if (!msi || !sums) throw new Error(`release ${latest.version} has no ${msi ? 'SHA256SUMS.txt' : msiName}`);
      if (isRunning(app)) throw new Error(`${app.name}.exe is running. Close it, then run update again.`);
      const sumsRes = await fetchFn(sums.browser_download_url, { headers: { 'user-agent': 'craft-integration' } });
      const expected = parseSums(await sumsRes.text()).get(msiName);
      if (!expected) throw new Error(`SHA256SUMS.txt does not list ${msiName}`);
      mkdirSync(downloads, { recursive: true });
      const file = join(downloads, msiName);
      // An earlier run whose install failed leaves its verified download; a partial one fails the hash and is fetched again.
      const kept = existsSync(file) && (await hashFile(file)) === expected;
      const actual = kept ? expected : await download(msi.browser_download_url, file, fetchFn);
      if (actual !== expected) {
        rmSync(file, { force: true });
        throw new Error(`checksum mismatch for ${msiName}; the file was deleted and nothing was installed`);
      }
      log(`VERIFIED ${app.label}: ${msiName}${size}, SHA-256 matches. Installing; Windows may ask to allow it.`);
      const code = installMsi(file);
      if (code !== 0 && code !== 3010) throw new Error(`msiexec exited with ${code}${MSI_EXIT[code] ?? ''}. The verified installer is kept at ${file}`);
      rmSync(file, { force: true });
      const now = installedVersion(exe);
      if (now !== latest.version) throw new Error(`installer finished but ${app.exe} reports ${now}`);
      log(`UPDATED  ${app.label}: ${have} -> ${now}${code === 3010 ? ' (Windows wants a restart)' : ''}`);
    } catch (err) {
      failed++;
      log(`FAIL     ${app.label}: ${err.message}`);
    }
  }
  if (!install) log(behind === 0 ? 'All apps are current.' : `${behind} app(s) have a newer release. Run: node craft.mjs update`);
  return failed;
}

// /passive shows progress without questions; per-machine installs still raise the Windows admin prompt.
function runMsiexec(file) {
  return spawnSync('msiexec', ['/i', file, '/passive', '/norestart'], { windowsHide: false }).status;
}
