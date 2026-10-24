import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { candidatePaths, expandHome, findExe, loadConfig, resolveArgs } from '../lib/config.mjs';
import { check, findClaude, installSkill, mergeAllowRules, saveSettings, setup, shellCommand } from '../lib/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, 'fixtures', 'fake-server.mjs');

function fakeConfig(extra = {}) {
  return {
    workFolder: '~/CraftWork',
    apps: [{ name: 'fake', label: 'Fake', exe: 'node', path: process.execPath, args: [fakeServer], probe: { tool: 'get_text' }, readOnlyTools: ['list_commands'], ...extra }],
  };
}

test('the shipped app list loads all thirteen apps, each once, each with a probe', () => {
  const config = loadConfig(join(here, '..', 'craft-apps.json'));
  const names = config.apps.map((a) => a.name);
  assert.equal(names.length, 13);
  assert.equal(new Set(names).size, 13);
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
