import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ServiceDef } from './detect.ts';
import type { LiveProxy } from './live.ts';
import { tr } from './i18n.ts';

export type Status = 'stopped' | 'running' | 'crashed';

function killTree(proc: ChildProcess) {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    // shell:true на винде — это cmd.exe, без /T внуки останутся жить
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

export class ServiceRunner extends EventEmitter {
  def: ServiceDef;
  status: Status = 'stopped';
  proxy: LiveProxy | null = null;
  private proc: ChildProcess | null = null;
  private stopping = false;
  private stopSeq = 0;

  constructor(def: ServiceDef) {
    super();
    this.def = def;
  }

  protected setStatus(s: Status) {
    this.status = s;
    this.emit('status', s);
  }

  private pipe(stream: Readable | null) {
    if (!stream) return;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) this.emit('log', l);
    });
    stream.on('end', () => {
      if (buf) this.emit('log', buf);
    });
  }

  start() {
    if (this.proc) return;
    this.stopping = false;
    const proc = spawn(this.def.command, {
      cwd: this.def.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    this.proc = proc;
    this.setStatus('running');
    this.pipe(proc.stdout);
    this.pipe(proc.stderr);
    proc.on('error', (e) => {
      this.emit('log', tr('не запустилось: {0}', e.message));
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // при остановке нами код всегда «1» от taskkill — не пугаем им
      this.emit('log', this.stopping ? tr('остановлен') : tr('остановлен (код {0})', code));
      this.setStatus(this.stopping || code === 0 ? 'stopped' : 'crashed');
    });
  }

  // убить процесс и дождаться выхода
  private halt(): Promise<void> {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      // на случай, если taskkill не сработал — не висим вечно
      const t = setTimeout(resolve, 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      killTree(proc);
    });
  }

  // явная остановка: отменяет и идущий в этот момент рестарт, иначе он поднял бы сервис заново
  stop(): Promise<void> {
    this.stopSeq++;
    return this.halt();
  }

  async restart() {
    const seq = this.stopSeq;
    await this.halt();
    if (seq !== this.stopSeq) return;
    this.start();
  }
}
