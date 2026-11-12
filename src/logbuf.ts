const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface LogLine {
  t: number;
  name: string;
  text: string;
}

// последние N строк логов всех сервисов — чтобы дашборд мог показать историю при открытии
export class LogBuffer {
  private lines: LogLine[] = [];
  private max: number;

  constructor(max = 2000) {
    this.max = max;
  }

  push(name: string, raw: string): LogLine {
    const line = { t: Date.now(), name, text: raw.replace(ANSI, '') };
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    return line;
  }

  all(): LogLine[] {
    return this.lines;
  }

  clear() {
    this.lines = [];
  }
}
