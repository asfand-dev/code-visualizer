/**
 * Desktop notifications for `serve --notify`: osascript (macOS), notify-send (Linux) or a PowerShell
 * toast (Windows). No dependency and no shell: texts travel as arguments or environment variables,
 * never inside a command line. Failures are swallowed and notifications are rate-limited.
 */
import { execFile } from 'node:child_process';
import type { NotifyMode } from '../analyzer/config.js';
import { liveEventLine, topEvent } from '../shared/live.js';
import type { LiveEvent } from '../shared/types.js';

export type { NotifyMode };

/** Starts a program without a shell; must never throw. */
export type Spawner = (command: string, args: string[], env?: Record<string, string>) => void;

export interface NotifyCommand {
  command: string;
  args: string[];
  /** Extra environment variables (the Windows script reads the texts from them). */
  env?: Record<string, string>;
}

const MAX_TITLE = 120;
const MAX_BODY = 400;
const clip = (text: string, max: number): string => {
  const line = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// The texts come from the environment, so nothing in them is ever parsed as PowerShell or XML.
const WINDOWS_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$texts = $xml.GetElementsByTagName('text')",
  '$texts.Item(0).AppendChild($xml.CreateTextNode($env:CV_NOTIFY_TITLE)) | Out-Null',
  '$texts.Item(1).AppendChild($xml.CreateTextNode($env:CV_NOTIFY_BODY)) | Out-Null',
  // PowerShell's own app id: toasts of unregistered app ids are not shown on Windows 10/11.
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ');

/** The program that shows a notification on `platform` (undefined where there is none). */
export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): NotifyCommand | undefined {
  const t = clip(title, MAX_TITLE);
  const b = clip(body, MAX_BODY);
  if (platform === 'darwin') {
    // The texts are script arguments (argv), not part of the AppleScript source.
    return { command: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', t, b] };
  }
  if (platform === 'win32') {
    // A plain static -Command (one argument, no shell): execution policies do not apply to it, and
    // -EncodedCommand / -ExecutionPolicy Bypass are what endpoint security flags as suspicious.
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], env: { CV_NOTIFY_TITLE: t, CV_NOTIFY_BODY: b } };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    // notify-send reads simple markup in the body; `--` ends its options (a text may start with "-").
    const markup = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { command: 'notify-send', args: ['--app-name=code-visualizer', '--', t, markup(b)] };
  }
  return undefined;
}

const defaultSpawner: Spawner = (command, args, env) => {
  try {
    const child = execFile(command, args, { timeout: 10_000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, () => undefined);
    child.on('error', () => undefined);
  } catch {
    /* notifications are best effort */
  }
};

export interface NotifierOptions {
  /** `errors`: error events only; `all`: errors, warnings and fixes; `off`: nothing. */
  mode: NotifyMode;
  /** Title of every notification (e.g. `code-visualizer · my-app`). */
  title?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawner;
  /** At most one notification per interval (default: 10 s). */
  intervalMs?: number;
  now?: () => number;
}

export interface Notifier {
  /**
   * Show the most important of `events` (when the mode wants one of them); true when a notification
   * was sent now. Inside the interval they are kept and summed up in one notification when it ends.
   */
  notify(events: readonly LiveEvent[]): boolean;
  /** Drop what is waiting for the end of the interval. */
  close(): void;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawner;
  const interval = options.intervalMs ?? 10_000;
  const now = options.now ?? Date.now;
  let last = -Infinity;
  /** Events that arrived inside the interval, for the notification at its end. */
  let waiting: LiveEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const wanted = (e: LiveEvent): boolean => (options.mode === 'all' ? e.severity !== 'info' : options.mode === 'errors' && e.severity === 'error');
  const send = (relevant: readonly LiveEvent[]): boolean => {
    const top = topEvent(relevant);
    if (!top) return false;
    const more = relevant.length - 1;
    const command = notifyCommand(platform, options.title ?? 'code-visualizer', `${liveEventLine(top)}${more > 0 ? ` (+${more} more)` : ''}`);
    if (!command) return false;
    last = now();
    try {
      spawn(command.command, command.args, command.env);
    } catch {
      /* best effort */
    }
    return true;
  };
  const flush = (): void => {
    timer = undefined;
    const pending = waiting;
    waiting = [];
    send(pending);
  };
  return {
    notify(events) {
      const relevant = events.filter(wanted);
      if (!relevant.length) return false;
      const wait = last + interval - now();
      if (wait <= 0 && !timer) return send(relevant);
      // Rate-limited: not lost, but summed up once the interval is over.
      waiting.push(...relevant);
      if (!timer) {
        timer = setTimeout(flush, Math.max(0, wait));
        timer.unref?.();
      }
      return false;
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
  };
}
