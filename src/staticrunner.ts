import { ServiceRunner } from './runner.ts';
import { startStaticServer } from './staticserver.ts';
import type { StaticServer } from './staticserver.ts';

// «Сервис» для сайта без бэкенда: вместо процесса поднимаем встроенный статический сервер.
// Для остального расширения он выглядит как обычный сервис (логи, статус, порт → прокси с живым обновлением).
export class StaticRunner extends ServiceRunner {
  private srv: StaticServer | null = null;
  private seq = 0;

  override start() {
    if (this.srv || this.status === 'running') return;
    const my = ++this.seq;
    this.setStatus('running');
    void startStaticServer(this.def.cwd).then(
      async (s) => {
        if (my !== this.seq) {
          await s.close(); // пока поднимались, нажали «стоп»
          return;
        }
        this.srv = s;
        this.emit('log', `Статический сайт: http://localhost:${s.port} (папка ${this.def.cwd})`);
      },
      (e: Error) => {
        if (my !== this.seq) return;
        this.emit('log', `не запустилось: ${e.message}`);
        this.setStatus('crashed');
      },
    );
  }

  override async stop() {
    this.seq++;
    const s = this.srv;
    this.srv = null;
    if (this.status !== 'stopped') {
      this.emit('log', 'остановлен');
      this.setStatus('stopped');
    }
    await s?.close();
  }

  override async restart() {
    await this.stop();
    this.start();
  }
}
