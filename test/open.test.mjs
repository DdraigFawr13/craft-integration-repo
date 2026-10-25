import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { fillArgs, guiPath, open, portAnswers, waitForPort } from '../lib/open.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, 'fixtures', 'fake-server.mjs');

// A free port: listen on 0, read it, close.
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function liveConfig(port) {
  return {
    workFolder: mkdtempSync(join(tmpdir(), 'craft-work-')),
    apps: [
      {
        name: 'fake', label: 'Fake', exe: 'node', path: process.execPath, args: [fakeServer],
        probe: { tool: 'get_text' }, readOnlyTools: ['list_commands'],
        live: { port, gui: process.execPath, guiArgs: ['--control', '{port}'], attach: [fakeServer, '--connect', '127.0.0.1:{port}'] },
      },
      { name: 'nolive', label: 'No Live', exe: 'node', path: process.execPath, args: [] },
    ],
  };
}

test('live arguments fill {port}, {tokenFile} and {workFolder}, and leave unknown names alone', () => {
  assert.deepEqual(
    fillArgs(['--control', '{port}', '--token', '{tokenFile}', '--root={workFolder}', '{other}'], { port: 18001, tokenFile: 'C:\\t', workFolder: 'C:\\W' }),
    ['--control', '18001', '--token', 'C:\\t', '--root=C:\\W', '{other}'],
  );
});

test('the window program is found beside the CLI', () => {
  assert.equal(guiPath('C:\\Program Files\\WordCraft\\wordcraft-cli.exe', { exe: 'wordcraft-cli' }), join('C:\\Program Files\\WordCraft', 'wordcraft.exe'));
});

test('every live port in the shipped list is unique, and PdfCraft has none', () => {
  const config = loadConfig(join(here, '..', 'craft-apps.json'));
  const ports = config.apps.filter((a) => a.live).map((a) => a.live.port);
  assert.equal(ports.length, 11);
  assert.equal(new Set(ports).size, 11);
  assert.equal(config.apps.find((a) => a.name === 'pdfcraft').live, undefined);
});

test('waitForPort sees a port that starts listening later, and gives up on one that never does', async () => {
  const port = await freePort();
  assert.equal(await portAnswers(port), false);
  const server = createServer();
  setTimeout(() => server.listen(port, '127.0.0.1'), 300);
  try {
    assert.equal(await waitForPort(port, 5000, 50), true);
  } finally {
    server.close();
  }
  assert.equal(await waitForPort(await freePort(), 300, 50), false);
});

test('open starts the window with its control port, waits for it, then attaches and probes', async () => {
  const port = await freePort();
  const config = liveConfig(port);
  let window = null;
  const launched = [];
  const lines = [];
  try {
    const tools = await open(config, 'fake', undefined, {
      register: false,
      log: (l) => lines.push(l),
      launch: (exe, args) => {
        launched.push([exe, args]);
        setTimeout(() => (window = createServer().listen(port, '127.0.0.1')), 200); // the "window" opens its port a little later
      },
    });
    assert.deepEqual(launched, [[process.execPath, ['--control', String(port)]]]);
    assert.equal(tools.length, 3);
    assert.match(lines[0], new RegExp(`^STARTED  Fake: .* on control port ${port}$`));
    assert.match(lines[1], new RegExp(`^ATTACHED Fake: 3 tools through .* --connect 127\\.0\\.0\\.1:${port}$`));
  } finally {
    window?.close();
  }
});

test('open reuses a window already listening on the port, and does not launch another', async () => {
  const port = await freePort();
  const window = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => window.once('listening', r));
  const lines = [];
  try {
    await open(liveConfig(port), 'fake', 'some.file', { register: false, log: (l) => lines.push(l), launch: () => assert.fail('launched') });
    assert.match(lines[0], /^RUNNING  Fake: something already answers/);
    assert.match(lines[1], /^NOTE     some\.file was not opened/);
  } finally {
    window.close();
  }
});

test('open fails clearly when the window never opens its port, or the app has no live entry', async () => {
  const port = await freePort();
  await assert.rejects(open(liveConfig(port), 'fake', undefined, { register: false, waitMs: 300, log: () => {}, launch: () => {} }), /did not open control port \d+ within 0.3 s/);
  await assert.rejects(open(liveConfig(port), 'nolive', undefined, { register: false }), /has no "live" entry/);
  await assert.rejects(open(liveConfig(port), 'nope', undefined, { register: false }), /no such app/);
});
