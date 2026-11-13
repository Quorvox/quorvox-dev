import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { cloneRepo, createEnvFromExample, extractZip, freeDir, healthReport, inspectProject, installCommand, installPython, parseRepoUrl, runInstall, zipName } from './importer.ts';
import type { Inspection } from './importer.ts';
import { tr } from './i18n.ts';

// Импорт чужого проекта: ссылка на GitHub или zip → папка → осмотр → мастер подготовки.
// После openFolder окно перезагружается, поэтому «мы посреди импорта» хранится в globalState.

export interface ImportDeps {
  root(): string | undefined;
  log(line: string): void;
  rescan(): Promise<void>;
}

const KEY = 'quorvox.onboarding';

interface Onboarding {
  dir: string;
  at: number;
}

export function registerImport(ctx: vscode.ExtensionContext, deps: ImportDeps): { disposables: vscode.Disposable[]; resume(): void } {
  async function importProject() {
    const GIT = { label: tr('$(github) Ссылка на репозиторий'), description: 'GitHub, GitLab, Bitbucket, Codeberg', id: 'git' };
    const ZIP = { label: tr('$(file-zip) Архив zip'), description: tr('скачанный проект или проект от нейросети'), id: 'zip' };
    const kind = await vscode.window.showQuickPick([GIT, ZIP], { title: tr('Импорт проекта'), placeHolder: tr('Откуда взять проект?') });
    if (!kind) return;

    let source: string;
    let name: string;
    let repo: ReturnType<typeof parseRepoUrl> | undefined;
    if (kind.id === 'git') {
      const url = await vscode.window.showInputBox({
        title: tr('Ссылка на репозиторий'),
        prompt: tr('Например https://github.com/автор/проект'),
        validateInput: (v) => ('error' in parseRepoUrl(v) ? (parseRepoUrl(v) as { error: string }).error : undefined),
      });
      if (!url) return;
      repo = parseRepoUrl(url);
      if ('error' in repo) return;
      source = repo.url;
      name = repo.name;
    } else {
      const z = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { Zip: ['zip'] }, openLabel: tr('Выбрать архив') });
      if (!z?.length) return;
      source = z[0].fsPath;
      name = zipName(source);
    }

    const parent = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(homedir()),
      openLabel: tr('Положить проект сюда'),
      title: tr('В какую папку положить проект? (внутри создам отдельную папку)'),
    });
    if (!parent?.length) return;
    const dest = freeDir(parent[0].fsPath, name);

    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: забираю проект {0}…', basename(dest)) }, async () => {
      deps.log(`[import] ${kind.id === 'git' ? 'git clone' : tr('распаковка')} → ${dest}`);
      const line = (l: string) => deps.log(`[import] ${l}`);
      return kind.id === 'git' && repo && !('error' in repo) ? cloneRepo(repo, dest, line) : extractZip(source, dest, line);
    });
    if (!ok) {
      void vscode.window.showErrorMessage(tr('Не получилось забрать проект. Подробности в панели «Вывод» → Quorvox Dev.'));
      return;
    }
    await ctx.globalState.update(KEY, { dir: dest, at: Date.now() } satisfies Onboarding);
    // открываем папку: окно перезагрузится, мастер покажется при старте расширения
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: false });
  }

  function summary(r: Inspection): string {
    const lines = [
      tr('Что это: {0}', r.stack.join(', ') || tr('не понял')),
      r.packageManager ? tr('Менеджер пакетов: {0}{1}, зависимостей: {2}', r.packageManager, r.hasLockfile ? '' : tr(' (lock-файла нет)'), r.depCount) : '',
      r.scripts.length ? tr('Скрипты: {0}', r.scripts.slice(0, 8).join(', ')) : '',
      r.nodeEngine ? tr('Нужен Node: {0}', r.nodeEngine) : '',
      r.envExample ? tr('Настройки: {0} (переменных: {1}){2}', r.envExample, r.envVars.length, r.envExists ? tr(', .env уже есть') : '') : '',
      ...r.notes.map((n) => '• ' + n),
    ].filter(Boolean);
    return lines.join('\n');
  }

  async function wizard(dir: string) {
    const r = inspectProject(dir);
    const GO = tr('Дальше');
    const first = await vscode.window.showInformationMessage(tr('Проект забрал. Вот что внутри:'), { modal: true, detail: summary(r) + tr('\n\nЧужой код я сам не запускаю. Дальше спрошу про каждый шаг отдельно.') }, GO);
    if (first !== GO) return finish();

    // честный отчёт: что найдут проверки и чего не хватает на этом компьютере, ничего не запуская
    const health = healthReport(dir, r);
    if (health.lines.length) {
      const CONT = tr('Понятно, дальше');
      const seen = await vscode.window.showWarningMessage(tr('Честный отчёт: что не так, ещё не запуская проект'), { modal: true, detail: tr('Ошибок: {0}, предупреждений: {1}', health.errors, health.warns) + '\n\n' + health.lines.join('\n') }, CONT);
      if (seen !== CONT) return finish();
    }

    // 1. зависимости
    if (r.packageManager && r.depCount > 0) {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(tr('Папка не отмечена как доверенная, установку и запуск пропускаю. Когда проверишь проект и доверишься папке, запусти «Quorvox: Импорт проекта» заново или установи зависимости сам.'));
        return finish();
      }
      const { cmd, args } = installCommand(r.packageManager, r.hasLockfile);
      const INSTALL = tr('Установить');
      const pick = await vscode.window.showWarningMessage(
        tr('Установить зависимости ({0})?', r.depCount),
        {
          modal: true,
          detail: tr('Команда: {0} {1}\n\nСкрипты установки (--ignore-scripts) отключены: чужие пакеты не смогут запустить свой код при установке. Но когда ты запустишь проект, его код и код пакетов выполнится, поэтому ставь, только если доверяешь источнику.', cmd, args.join(' ')),
        },
        INSTALL,
      );
      if (pick === INSTALL) {
        const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: ставлю зависимости…') }, () => runInstall(dir, r.packageManager!, r.hasLockfile, (l) => deps.log(`[install] ${l}`)));
        if (code !== 0) {
          void vscode.window.showErrorMessage(tr('Установка закончилась с ошибкой (код {0}). Смотри «Вывод» → Quorvox Dev.', code));
          return finish();
        }
        deps.log(tr('[install] готово'));
      }
    }

    // 1b. Python: свой venv внутри проекта
    if (r.python.requirements && r.python.framework) {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(tr('Папка не отмечена как доверенная, установку и запуск пропускаю. Когда проверишь проект и доверишься папке, запусти «Quorvox: Импорт проекта» заново или установи зависимости сам.'));
        return finish();
      }
      const PYINSTALL = tr('Установить');
      const pick = await vscode.window.showWarningMessage(
        tr('Поставить Python-зависимости?'),
        { modal: true, detail: tr('Создам папку .venv внутри проекта и поставлю туда пакеты из requirements.txt только в готовом виде (--only-binary): так при установке не запустится чужой setup.py. Системный Python не трогаю.') },
        PYINSTALL,
      );
      if (pick === PYINSTALL) {
        const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: ставлю Python-пакеты…') }, () => installPython(dir, (l) => deps.log(`[pip] ${l}`)));
        if (code !== 0) {
          void vscode.window.showErrorMessage(tr('Установка Python-пакетов закончилась с ошибкой (код {0}). Если пакет есть только в исходниках, поставь его сам в .venv. Смотри «Вывод» → Quorvox Dev.', code));
          return finish();
        }
        deps.log(tr('[install] готово'));
      }
    }

    // 2. .env
    if (r.envExample && !r.envExists) {
      const MAKE = tr('Создать .env');
      const pick = await vscode.window.showInformationMessage(tr('В проекте есть {0}. Создать из него .env?', r.envExample), { modal: true, detail: tr('Скопирую как есть. Секреты (токены, пароли, ключи) в нём нужно вписать самому: я их не придумываю и никуда не отправляю.') }, MAKE);
      if (pick === MAKE && createEnvFromExample(dir, r.envExample)) await vscode.window.showTextDocument(vscode.Uri.file(join(dir, '.env')));
    }

    // 3. запуск и карта
    await deps.rescan();
    if (r.runnable && vscode.workspace.isTrusted) {
      const RUN = tr('Запустить и открыть карту');
      const pick = await vscode.window.showInformationMessage(tr('Запустить проект?'), { modal: true, detail: tr('Это выполнит код проекта на твоём компьютере.') }, RUN);
      if (pick === RUN) {
        await vscode.commands.executeCommand('quorvox.toggle');
        await vscode.commands.executeCommand('quorvox.map');
      }
    } else {
      await vscode.commands.executeCommand('quorvox.map');
    }
    finish();
  }

  function finish() {
    void ctx.globalState.update(KEY, undefined);
  }

  // при старте: если эту папку открыли после импорта — показываем мастер один раз
  function resume() {
    const st = ctx.globalState.get<Onboarding>(KEY);
    const dir = deps.root();
    if (!st || !dir) return;
    if (st.dir.toLowerCase() !== dir.toLowerCase() || Date.now() - st.at > 24 * 3600_000) {
      if (Date.now() - st.at > 24 * 3600_000) finish();
      return;
    }
    setTimeout(() => void wizard(dir), 1200);
  }

  const disposables = [
    vscode.commands.registerCommand('quorvox.import', importProject),
    vscode.commands.registerCommand('quorvox.onboard', () => {
      const dir = deps.root();
      if (dir) void wizard(dir);
    }),
  ];
  return { disposables, resume };
}
