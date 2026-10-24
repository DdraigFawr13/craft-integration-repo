import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseSums, parseVersion, releaseRepo, update } from '../lib/update.mjs';

// The stand-in app is node itself, so its installed version is this Node's.
const nodeVersion = process.versions.node;
const config = { releaseOwner: 'storytold', apps: [{ name: 'fake', label: 'Fake', exe: 'node', path: process.execPath, args: [] }] };
const msiName = 'fake-99.0.0-windows-x64.msi';
const msiBytes = 'pretend installer';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function fakeGitHub({ version = '99.0.0', sums = `${sha(msiBytes)}  ${msiName}\n` } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: `v${version}`,
        assets: [
          { name: msiName, size: 5 * 1048576, browser_download_url: 'https://dl/msi' },
          { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://dl/sums' },
        ],
      });
    }
    if (url === 'https://dl/sums') return new Response(sums);
    if (url === 'https://dl/msi') return new Response(msiBytes);
    return new Response('', { status: 404 });
  };
  return { fetchFn, calls };
}

test('versions are read from --version text and release tags, and compared numerically', () => {
  assert.equal(parseVersion('photocraft-cli 0.12.0 (6a2d027ee, 2026-10-21)'), '0.12.0');
  assert.equal(parseVersion('v0.15.1'), '0.15.1');
  assert.equal(parseVersion('no version'), null);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.15.1', '0.15.1'), 0);
});

test('SHA256SUMS.txt lines are read with or without the binary-mode star', () => {
  const sums = parseSums(`${'a'.repeat(64)}  x.msi\r\n${'B'.repeat(64)} *y.zip\nnot a line\n`);
  assert.equal(sums.get('x.msi'), 'a'.repeat(64));
  assert.equal(sums.get('y.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the release repo is the owner plus the app name, unless the app names its own', () => {
  assert.equal(releaseRepo(config, config.apps[0]), 'storytold/fake');
  assert.equal(releaseRepo(config, { name: 'fake', repo: 'me/fork' }), 'me/fork');
});

test('update --check reports a newer release with its installer and size, and downloads nothing', async () => {
  const { fetchFn, calls } = fakeGitHub();
  const lines = [];
  assert.equal(await update(config, { fetchFn, log: (l) => lines.push(l) }), 0);
  assert.equal(lines[0], `BEHIND   Fake: ${nodeVersion} -> 99.0.0, ${msiName} (5 MB) from github.com/storytold/fake`);
  assert.deepEqual(calls, ['https://api.github.com/repos/storytold/fake/releases/latest']);
});

test('an app already on the latest release is reported current', async () => {
  const { fetchFn } = fakeGitHub({ version: nodeVersion });
  const lines = [];
  await update(config, { fetchFn, log: (l) => lines.push(l) });
  assert.deepEqual(lines, [`CURRENT  Fake: ${nodeVersion}`, 'All apps are current.']);
});

test('a download whose checksum does not match is deleted and never installed', async () => {
  const { fetchFn } = fakeGitHub({ sums: `${'0'.repeat(64)}  ${msiName}\n` });
  const downloads = mkdtempSync(join(tmpdir(), 'craft-dl-'));
  let installed = false;
  const lines = [];
  const failed = await update(config, { install: true, fetchFn, downloads, installMsi: () => { installed = true; return 0; }, log: (l) => lines.push(l) });
  assert.equal(failed, 1);
  assert.equal(installed, false);
  assert.match(lines[0], /checksum mismatch .* nothing was installed$/);
  assert.equal(existsSync(join(downloads, msiName)), false);
});

test('a verified installer is run, and update fails if the app still reports the old version', async () => {
  const { fetchFn } = fakeGitHub();
  const downloads = mkdtempSync(join(tmpdir(), 'craft-dl-'));
  let ranWith = null;
  const lines = [];
  const failed = await update(config, { install: true, fetchFn, downloads, installMsi: (file) => { ranWith = file; return 0; }, log: (l) => lines.push(l) });
  assert.equal(ranWith, join(downloads, msiName));
  assert.match(lines[0], /^VERIFIED Fake: .*SHA-256 matches/);
  assert.equal(failed, 1);
  assert.match(lines[1], new RegExp(`installer finished but node reports ${nodeVersion.replaceAll('.', '\\.')}$`));
});

test('a cancelled install is reported as cancelled', async () => {
  const { fetchFn } = fakeGitHub();
  const lines = [];
  await update(config, { install: true, fetchFn, downloads: mkdtempSync(join(tmpdir(), 'craft-dl-')), installMsi: () => 1602, log: (l) => lines.push(l) });
  assert.match(lines[1], /msiexec exited with 1602 \(cancelled\)\. The verified installer is kept at /);
});

test('a verified download kept from a failed install is reused; a partial one is fetched again', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'craft-dl-'));
  writeFileSync(join(downloads, msiName), msiBytes);
  const reused = fakeGitHub();
  await update(config, { install: true, fetchFn: reused.fetchFn, downloads, installMsi: () => 1619, log: () => {} });
  assert.equal(reused.calls.includes('https://dl/msi'), false);
  writeFileSync(join(downloads, msiName), msiBytes.slice(0, 4));
  const refetched = fakeGitHub();
  const lines = [];
  await update(config, { install: true, fetchFn: refetched.fetchFn, downloads, installMsi: () => 1619, log: (l) => lines.push(l) });
  assert.equal(refetched.calls.includes('https://dl/msi'), true);
  assert.match(lines[1], /1619 \(Windows Installer could not open the package; .*run update from your own terminal\)/);
});

test('naming an app that is not in the list is refused', async () => {
  await assert.rejects(update(config, { only: ['nope'] }), /no such app in craft-apps.json: nope/);
});
