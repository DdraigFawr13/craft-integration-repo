import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSums, parseVersion, releaseRepo, swapJunction, update } from '../lib/update.mjs';

// The stand-in app is installed "for all users" as node itself, reporting 1.0.0. A per-user copy is a folder
// whose fake-cli.exe is a text file holding its version, so versionOf can read either.
const config = { releaseOwner: 'storytold', apps: [{ name: 'fake', label: 'Fake', installDir: 'Fake', exe: 'fake-cli', path: process.execPath, args: [] }] };
const versionOf = (exe) => (exe === process.execPath ? '1.0.0' : readFileSync(exe, 'utf8'));
const zipBytes = 'pretend zip';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const zipName = (v) => `fake-${v}-windows-x64-portable.zip`;

function fakeGitHub(version, { sums } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: `v${version}`,
        assets: [
          { name: zipName(version), size: 5 * 1048576, browser_download_url: 'https://dl/zip' },
          { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://dl/sums' },
        ],
      });
    }
    if (url === 'https://dl/sums') return new Response(sums ?? `${sha(zipBytes)}  ${zipName(version)}\n`);
    if (url === 'https://dl/zip') return new Response(zipBytes);
    return new Response('', { status: 404 });
  };
  return { fetchFn, calls };
}

// Unpacks like a release zip: one top folder holding the CLI, here reporting `reports`.
const fakeExtract = (reports) => (zip, dir) => {
  const top = join(dir, 'fake-portable');
  mkdirSync(top);
  writeFileSync(join(top, 'fake-cli.exe'), reports);
};

function run(version, base, { reports = version, sums } = {}) {
  const lines = [];
  const gh = fakeGitHub(version, { sums });
  const failed = update(config, { install: true, base, fetchFn: gh.fetchFn, extract: fakeExtract(reports), versionOf, log: (l) => lines.push(l) });
  return failed.then((n) => ({ failed: n, lines, calls: gh.calls }));
}

test('versions are read from --version text and release tags, and compared numerically', () => {
  assert.equal(parseVersion('photocraft-cli 0.12.0 (6a2d027ee, 2026-10-21)'), '0.12.0');
  assert.equal(parseVersion('SoundCraft CLI 0.12.1'), '0.12.1');
  assert.equal(parseVersion('no version'), null);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.15.1', '0.15.1'), 0);
});

test('SHA256SUMS.txt lines are read with or without the binary-mode star', () => {
  const sums = parseSums(`${'a'.repeat(64)}  x.zip\r\n${'B'.repeat(64)} *y.zip\nnot a line\n`);
  assert.equal(sums.get('x.zip'), 'a'.repeat(64));
  assert.equal(sums.get('y.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the release repo is the owner plus the app name, unless the app names its own', () => {
  assert.equal(releaseRepo(config, config.apps[0]), 'storytold/fake');
  assert.equal(releaseRepo(config, { name: 'fake', repo: 'me/fork' }), 'me/fork');
});

test('update --check reports the zip it would install, and downloads nothing', async () => {
  const { fetchFn, calls } = fakeGitHub('2.0.0');
  const lines = [];
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  assert.equal(await update(config, { base, fetchFn, versionOf, log: (l) => lines.push(l) }), 0);
  assert.equal(lines[0], `PENDING  Fake: 1.0.0 -> 2.0.0; ${zipName('2.0.0')} (5 MB) from github.com/storytold/fake`);
  assert.deepEqual(calls, ['https://api.github.com/repos/storytold/fake/releases/latest']);
  assert.equal(existsSync(join(base, 'Programs')), false);
});

test('an app only installed for all users is installed per user even when current, then says to run setup', async () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  const { failed, lines } = await run('1.0.0', base);
  assert.equal(failed, 0);
  assert.match(lines[0], /^UPDATED  Fake: 1\.0\.0, only installed for all users .*; now 1\.0\.0 in .*Programs.Fake \(SHA-256 verified\)$/);
  assert.match(lines[1], /^NOTE     1 app\(s\) now run from %LOCALAPPDATA%\\Programs\. Run setup/);
  assert.ok(lstatSync(join(base, 'Programs', 'Fake')).isSymbolicLink(), 'Programs\\Fake is a junction');
  assert.equal(readFileSync(join(base, 'Programs', 'Fake', 'fake-cli.exe'), 'utf8'), '1.0.0');
  assert.deepEqual(readdirSync(join(base, 'craft', 'apps')), ['fake-1.0.0']);
  assert.deepEqual(readdirSync(join(base, 'craft', 'downloads')), [], 'the zip is deleted');
});

test('a newer release swaps the junction to a new folder and removes the old version', async () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  await run('1.0.0', base);
  const { failed, lines } = await run('1.1.0', base);
  assert.equal(failed, 0);
  assert.match(lines[0], /^UPDATED  Fake: 1\.0\.0 -> 1\.1\.0; now 1\.1\.0/);
  assert.equal(lines.length, 1, 'no setup note: the path Claude uses did not change');
  assert.equal(readFileSync(join(base, 'Programs', 'Fake', 'fake-cli.exe'), 'utf8'), '1.1.0');
  assert.deepEqual(readdirSync(join(base, 'craft', 'apps')), ['fake-1.1.0']);
  const again = await run('1.1.0', base);
  assert.deepEqual(again.lines, ['CURRENT  Fake: 1.1.0']);
});

test('a download whose checksum does not match is deleted and nothing is installed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  const { failed, lines } = await run('2.0.0', base, { sums: `${'0'.repeat(64)}  ${zipName('2.0.0')}\n` });
  assert.equal(failed, 1);
  assert.match(lines[0], /checksum mismatch .* nothing was installed$/);
  assert.equal(existsSync(join(base, 'Programs', 'Fake')), false);
  assert.deepEqual(readdirSync(join(base, 'craft', 'downloads')), []);
});

test('an unpacked CLI that reports the wrong version is not switched to', async () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  await run('1.0.0', base);
  const { failed, lines } = await run('2.0.0', base, { reports: '1.9.9' });
  assert.equal(failed, 1);
  assert.match(lines[0], /the unpacked fake-cli reports 1\.9\.9, not 2\.0\.0$/);
  assert.equal(readFileSync(join(base, 'Programs', 'Fake', 'fake-cli.exe'), 'utf8'), '1.0.0');
});

test('a verified zip kept from an interrupted run is reused', async () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  mkdirSync(join(base, 'craft', 'downloads'), { recursive: true });
  writeFileSync(join(base, 'craft', 'downloads', zipName('2.0.0')), zipBytes);
  const { failed, calls } = await run('2.0.0', base);
  assert.equal(failed, 0);
  assert.equal(calls.includes('https://dl/zip'), false);
});

test('a real folder where the junction belongs is never replaced', () => {
  const base = mkdtempSync(join(tmpdir(), 'craft-base-'));
  mkdirSync(join(base, 'Fake'));
  mkdirSync(join(base, 'v1'));
  assert.throws(() => swapJunction(join(base, 'Fake'), join(base, 'v1')), /is a real folder, not a junction made by update/);
});

test('naming an app that is not in the list is refused', async () => {
  await assert.rejects(update(config, { only: ['nope'] }), /no such app in craft-apps.json: nope/);
});
