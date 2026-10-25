// A minimal stdio MCP client: enough to start a server, list its tools and call one.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor(command, args, { timeoutMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => {
        this.failAll(err);
        resolve();
      });
      this.child.on('exit', (code) => {
        this.failAll(new Error(`server exited with code ${code}${this.stderrTail()}`));
        resolve();
      });
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stdout should carry only protocol messages; skip anything else
    }
    const waiter = msg.id != null && this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(`${msg.error.message ?? 'error'} (code ${msg.error.code})`));
    else waiter.resolve(msg.result);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${this.timeoutMs} ms${this.stderrTail()}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  send(msg) {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'craft-check', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exited;
    clearTimeout(timer);
  }

  failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  stderrTail() {
    const tail = this.stderr.trim().split('\n').slice(-3).join(' | ');
    return tail ? `; stderr: ${tail}` : '';
  }
}
