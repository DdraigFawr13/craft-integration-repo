import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { candidatePaths, expandHome, findExe, loadConfig, resolveArgs, serverCommand } from '../lib/config.mjs';
import { check, findClaude, installRunner, installSkill, mergeAllowRules, saveSettings, setup, shellCommand } from '../lib/commands.mjs';
import { McpClient } from '../lib/mcp-client.mjs';
import { prepareCopy, removeOldCopies } from '../lib/server-copy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, 'fixtures', 'fake-server.mjs');

function fakeConfig(extra = {}) {
  return {
    workFolder: '~/CraftWork',
    apps: [{ name: 'fake', label: 'Fake', exe: 'node', path: process.execPath, args: [fakeServer], probe: { tool: 'get_text' }, readOnlyTools: ['list_commands'], ...extra }],
  };
}

test('the shipped app list loads all fourteen apps, each once, each with a probe', () => {
  const config = loadConfig(join(here, '..', 'craft-apps.json'));
  const names = config.apps.map((a) => a.name);
  assert.equal(names.length, 14);
  assert.equal(new Set(names).size, 14);
  for (const app of config.apps) assert.ok(app.probe?.tool, `${app.name} has a probe`);
});

test('a config with a bad app name is refused', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'craft-')), 'bad.json');
  writeFileSync(file, JSON.stringify({ apps: [{ name: 'Bad Name', label: 'x', exe: 'x', args: [] }] }));
  assert.throws(() => loadConfig(file), /may use only/);
});

test('a config saved with a UTF-8 byte order mark loads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'craft-')), 'bom.json');
  writeFileSync(file, `﻿${JSON.stringify(fakeConfig())}`);
  assert.equal(loadConfig(file).apps[0].name, 'fake');
});

test('the launcher\'s portable install is searched first, then its MSI install in Program Files, then PATH', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local', PATH: 'C:\\bin' };
  const app = { name: 'wordcraft', exe: 'wordcraft-cli', installDir: 'WordCraft' };
  assert.deepEqual(candidatePaths(app, env, 'win32'), [
    'C:\\Users\\m\\AppData\\Local\\ArtCraft Launcher\\apps\\wordcraft\\wordcraft-cli.exe',
    'C:\\Program Files\\WordCraft\\wordcraft-cli.exe',
    'C:\\bin\\wordcraft-cli.exe',
  ]);
  assert.equal(findExe(app, env, 'win32', (p) => p.startsWith('C:\\Program')), 'C:\\Program Files\\WordCraft\\wordcraft-cli.exe');
});

test('the work folder fills in {workFolder} and ~ expands to home', () => {
  assert.equal(expandHome('~/CraftWork', '/home/m'), join('/home/m', 'CraftWork'));
  assert.deepEqual(resolveArgs({ args: ['mcp', '--root', '{workFolder}'] }, 'C:\\W'), ['mcp', '--root', 'C:\\W']);
});

test('shell commands quote paths with spaces and refuse cmd.exe metacharacters', () => {
  assert.equal(
    shellCommand(['claude', 'mcp', 'add', '--', 'C:\\Program Files\\WordCraft\\wordcraft-cli.exe', 'mcp'], 'win32'),
    'claude mcp add -- "C:\\Program Files\\WordCraft\\wordcraft-cli.exe" mcp',
  );
  assert.throws(() => shellCommand(['a&b'], 'win32'), /cannot be passed safely/);
  assert.equal(shellCommand(['/opt/My App/x', "it's"], 'linux'), "'/opt/My App/x' 'it'\\''s'");
});

test('claude.exe is found in ~/.local/bin when it is not on PATH', () => {
  const env = { Path: 'C:\\Windows\\system32' };
  const found = findClaude(env, 'win32', (p) => p === 'C:\\Users\\m\\.local\\bin\\claude.exe', 'C:\\Users\\m');
  assert.equal(found, 'C:\\Users\\m\\.local\\bin\\claude.exe');
  assert.equal(findClaude(env, 'win32', () => false, 'C:\\Users\\m'), null);
});

test('allow rules are added once and existing settings are kept', () => {
  const settings = { model: 'x', permissions: { allow: ['Bash(ls)', 'mcp__wordcraft__get_text'], deny: ['Read(.env)'] } };
  const { merged, added } = mergeAllowRules(settings, ['mcp__wordcraft__get_text', 'mcp__wordcraft__parity']);
  assert.deepEqual(added, ['mcp__wordcraft__parity']);
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'mcp__wordcraft__get_text', 'mcp__wordcraft__parity']);
  assert.deepEqual(merged.permissions.deny, ['Read(.env)']);
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)', 'mcp__wordcraft__get_text'], 'input is not changed');
});

test('a settings save that fails leaves the old file and explains what happened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-settings-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{"model":"x"}\n');
  mkdirSync(`${file}.tmp`); // a folder in the temp file's place makes the write fail on every platform
  assert.throws(() => saveSettings(file, { model: 'y' }), /could not save the allow rules.*is unchanged/s);
  assert.equal(readFileSync(file, 'utf8'), '{"model":"x"}\n');
  saveSettings(join(dir, 'fresh.json'), { model: 'y' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fresh.json'), 'utf8')), { model: 'y' });
  assert.equal(existsSync(join(dir, 'fresh.json.tmp')), false);
});

test('setup --dry-run prints the commands and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'craft-home-'));
  const lines = [];
  const rules = setup(fakeConfig(), { dryRun: true, home, log: (l) => lines.push(l) });
  assert.deepEqual(rules, ['mcp__fake__list_commands']);
  assert.match(lines[0], /^WOULD RUN {2}\S*claude\S* mcp add --scope user fake -- /);
  assert.match(lines[1], /^WOULD INSTALL the craft-apps skill at /);
  assert.throws(() => readFileSync(join(home, '.claude', 'settings.json')));
  assert.equal(existsSync(join(home, '.claude', 'skills')), false);
});

test('the craft-apps skill is installed with this checkout, the work folder and the release owner filled in', () => {
  const home = mkdtempSync(join(tmpdir(), 'craft-home-'));
  const lines = [];
  installSkill({ workFolder: '~/CraftWork', releaseOwner: 'storytold' }, { home, log: (l) => lines.push(l) });
  const skill = readFileSync(join(home, '.claude', 'skills', 'craft-apps', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: craft-apps\ndescription: /);
  assert.ok(skill.includes(`${join(here, '..')}/craft-apps.json`), 'points at this checkout');
  assert.ok(skill.includes(join(home, 'CraftWork')), 'names the work folder');
  assert.ok(skill.includes('https://github.com/storytold/<app>/blob/main/<guide>'));
  assert.doesNotMatch(skill, /\{(repo|workFolder|releaseOwner)\}/);
  assert.match(lines[0], /^SKILL {4}craft-apps installed at /);
});

test('every app in the shipped list says what it is for and where its agent guide is', () => {
  for (const app of loadConfig(join(here, '..', 'craft-apps.json')).apps) {
    assert.ok(app.use, `${app.name} has a use line`);
    assert.match(app.guide ?? '', /\.md$/, `${app.name} has a guide`);
  }
});

test('check passes against a server that answers, following tool-list pages', async () => {
  const lines = [];
  assert.equal(await check(fakeConfig(), { log: (l) => lines.push(l) }), 0);
  assert.match(lines[0], /^PASS {5}Fake: fake 1.0, 3 tools$/);
});

test('check fails when readOnlyTools names a tool the server marks as writing', async () => {
  const lines = [];
  assert.equal(await check(fakeConfig({ readOnlyTools: ['list_commands', 'save'] }), { log: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /does not mark read-only: save$/);
});

test('check says to run setup when an app needs a work folder that is missing', async () => {
  const lines = [];
  const config = { ...fakeConfig({ args: [fakeServer, '--root', '{workFolder}'] }), workFolder: join(tmpdir(), 'craft-no-such-folder') };
  assert.equal(await check(config, { log: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /does not exist yet\. Run setup first\.$/);
});

test('check fails when the config names a tool the server lacks', async () => {
  const lines = [];
  assert.equal(await check(fakeConfig({ readOnlyTools: ['render_page'] }), { log: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /lacks: render_page/);
});

test('check fails when the probe call returns a tool error', async () => {
  process.env.FAKE_MODE = 'tool-error';
  try {
    const lines = [];
    assert.equal(await check(fakeConfig(), { log: (l) => lines.push(l) }), 1);
    assert.match(lines[0], /get_text returned an error: no document/);
  } finally {
    delete process.env.FAKE_MODE;
  }
});

// A stand-in for a launcher install: the CLI, its window program, portable mode's files and a model the CLI needs.
function fakeInstall() {
  const dir = mkdtempSync(join(tmpdir(), 'craft-app-'));
  const exe = join(dir, 'fake-cli.exe');
  writeFileSync(exe, 'version one');
  writeFileSync(join(dir, 'fake.exe'), 'window');
  writeFileSync(join(dir, 'portable.txt'), 'portable');
  mkdirSync(join(dir, 'FakeData'));
  writeFileSync(join(dir, 'FakeData', 'ui.json'), '{}');
  mkdirSync(join(dir, 'models'));
  writeFileSync(join(dir, 'models', 'm.onnx'), 'model');
  return { dir, exe, root: mkdtempSync(join(tmpdir(), 'craft-state-')) };
}

test('a launcher install starts through the runner; a path of your own or on PATH starts as it is', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L', PATH: 'C:\\bin' };
  const app = { name: 'wordcraft', exe: 'wordcraft-cli', installDir: 'WordCraft' };
  for (const exe of ['C:\\L\\ArtCraft Launcher\\apps\\wordcraft\\wordcraft-cli.exe', 'C:\\Program Files\\WordCraft\\wordcraft-cli.exe']) {
    assert.deepEqual(serverCommand(app, exe, ['mcp'], 'C:\\r.mjs', env, 'win32'), { command: process.execPath, args: ['C:\\r.mjs', exe, 'mcp'] });
  }
  assert.deepEqual(serverCommand(app, 'C:\\bin\\wordcraft-cli.exe', ['mcp'], 'C:\\r.mjs', env, 'win32'), { command: 'C:\\bin\\wordcraft-cli.exe', args: ['mcp'] });
  assert.deepEqual(serverCommand(app, '/usr/bin/wordcraft-cli', ['mcp'], '/r.mjs', env, 'linux'), { command: '/usr/bin/wordcraft-cli', args: ['mcp'] });
});

test('the copy holds what the server needs, not the window program or portable mode\'s files', () => {
  const { dir, exe, root } = fakeInstall();
  const copied = prepareCopy(exe, root);
  assert.notEqual(dirname(copied), dir);
  assert.deepEqual(readdirSync(dirname(copied)).sort(), ['fake-cli.exe', 'models']);
  assert.equal(readFileSync(join(dirname(copied), 'models', 'm.onnx'), 'utf8'), 'model');
});

test('an unchanged CLI reuses its copy; an updated one gets a new copy and the old one goes', () => {
  const { exe, root } = fakeInstall();
  const first = prepareCopy(exe, root);
  const marker = join(dirname(first), 'marker');
  writeFileSync(marker, 'kept');
  assert.equal(prepareCopy(exe, root), first);
  assert.ok(existsSync(marker), 'the copy was not made again');
  writeFileSync(exe, 'version two, longer');
  const second = prepareCopy(exe, root);
  assert.notEqual(second, first);
  assert.equal(readFileSync(second, 'utf8'), 'version two, longer');
  assert.equal(existsSync(first), false);
  assert.deepEqual(readdirSync(dirname(dirname(second))).length, 1);
});

test('an old copy whose CLI cannot be deleted stays whole; a fresh partial copy from another session is left alone', () => {
  const versions = mkdtempSync(join(tmpdir(), 'craft-versions-'));
  // A folder in the CLI's place fails the delete the way a running program does on Windows.
  mkdirSync(join(versions, 'old', 'fake-cli.exe', 'x'), { recursive: true });
  writeFileSync(join(versions, 'old', 'needed'), 'x');
  mkdirSync(join(versions, 'new.tmp-1'));
  mkdirSync(join(versions, 'stale.tmp-2'));
  mkdirSync(join(versions, 'new'));
  removeOldCopies(versions, 'new', 'fake-cli.exe');
  assert.ok(existsSync(join(versions, 'old', 'needed')));
  assert.ok(existsSync(join(versions, 'new.tmp-1')));
  utimesSync(join(versions, 'stale.tmp-2'), new Date(0), new Date(0));
  removeOldCopies(versions, 'new', 'fake-cli.exe');
  assert.equal(existsSync(join(versions, 'stale.tmp-2')), false);
  assert.ok(existsSync(join(versions, 'new')));
});

test('a server started through the runner answers, and its original can be replaced while it runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-app-'));
  const exe = join(dir, 'fake-cli.exe');
  copyFileSync(process.execPath, exe);
  const local = mkdtempSync(join(tmpdir(), 'craft-local-'));
  installRunner(local);
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = local;
  const client = new McpClient(process.execPath, [join(local, 'run-server.mjs'), exe, fakeServer], { timeoutMs: 60000 });
  try {
    assert.equal((await client.initialize()).serverInfo.name, 'fake');
    rmSync(exe); // Windows refuses this for a running program, so it passes only if the copy is what runs
    assert.equal(existsSync(exe), false);
    assert.equal((await client.request('tools/list')).tools.length > 0, true);
  } finally {
    await client.close();
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test('check reports a server that exits at start, with its stderr', async () => {
  process.env.FAKE_MODE = 'crash';
  try {
    const lines = [];
    assert.equal(await check(fakeConfig(), { log: (l) => lines.push(l), timeoutMs: 5000 }), 1);
    assert.match(lines[0], /exited with code 3; stderr: fake server could not start/);
  } finally {
    delete process.env.FAKE_MODE;
  }
});
