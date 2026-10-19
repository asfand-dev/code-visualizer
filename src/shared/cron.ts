/**
 * Cron expressions as GitHub Actions' `schedule` uses them (five fields, always UTC): a plain-English
 * description, the next run and how often it fires. Pure.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOOKAHEAD_DAYS = 400;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const DIGITS = /^\d+$/;

interface CronFields {
  minutes: number[];
  hours: number[];
  /** Days of the month and of the week as sets; the `restricted` flags follow cron's "either day matches" rule. */
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** `*`, `5`, `1-5`, `*\/15`, `1-30/5` and comma lists of those, as the values they stand for. */
function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return undefined;
    const step = match[2] ? Number(match[2]) : 1;
    if (step < 1) return undefined;
    const [from, to] = rangeOf(match[1], min, max);
    if (from < min || to > max || from > to) return undefined;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function rangeOf(text: string, min: number, max: number): [number, number] {
  if (text === '*') return [min, max];
  const [from, to] = text.split('-').map(Number);
  return [from, to ?? from];
}

function parseCron(expression: string): CronFields | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 7),
  ];
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return undefined;
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function dayMatches(fields: CronFields, day: Date): boolean {
  if (!fields.months.has(day.getUTCMonth() + 1)) return false;
  const dom = fields.daysOfMonth.has(day.getUTCDate());
  const dow = fields.daysOfWeek.has(day.getUTCDay());
  // Cron runs a job when either day field matches, if both are restricted.
  return fields.domRestricted && fields.dowRestricted ? dom || dow : dom && dow;
}

/** The next time (ms) the expression fires after `after`, or undefined when it is invalid or never fires within a year. */
export function nextCronRun(expression: string, after: number): number | undefined {
  const fields = parseCron(expression);
  if (!fields) return undefined;
  const earliest = Math.floor(after / MS_PER_MINUTE) * MS_PER_MINUTE + MS_PER_MINUTE;
  const start = new Date(earliest);
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offset));
    if (!dayMatches(fields, day)) continue;
    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        const time = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
        if (time >= earliest) return time;
      }
    }
  }
  return undefined;
}

/** The shortest time in minutes between two runs on a day the expression fires (`*\/5 * * * *` → 5, `0 3 * * *` → 1440). */
export function cronIntervalMinutes(expression: string): number | undefined {
  const fields = parseCron(expression);
  if (!fields) return undefined;
  const times = fields.hours.flatMap((hour) => fields.minutes.map((minute) => hour * MINUTES_PER_HOUR + minute));
  const gaps = times.map((time, i) => (i + 1 < times.length ? times[i + 1] : times[0] + MINUTES_PER_DAY) - time);
  return Math.min(...gaps);
}

const pad = (value: string): string => value.padStart(2, '0');

function describeWeekdays(field: string): string | undefined {
  if (field === '1-5') return 'Weekdays';
  if (field === '0,6' || field === '6,0') return 'Weekends';
  if (!/^[0-7](,[0-7])*$/.test(field)) return undefined;
  const names = field.split(',').map((day) => WEEKDAYS[Number(day) % 7]);
  return names.length === 1 ? `Every ${names[0]}` : names.join(', ');
}

/** `0 3 * * 1` → "Every Monday at 03:00 UTC". Expressions it does not recognise are returned as written. */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, dom, month, dow] = parts;
  const everyDay = dom === '*' && month === '*' && dow === '*';
  const step = /^\*\/(\d+)$/.exec(minute);
  if (hour === '*' && everyDay) {
    if (minute === '*') return 'Every minute';
    if (step) return `Every ${step[1]} minutes`;
    if (DIGITS.test(minute)) return minute === '0' ? 'Every hour' : `Every hour at minute ${minute}`;
    return expression;
  }
  if (!DIGITS.test(minute) || !DIGITS.test(hour) || month !== '*') return expression;
  const time = `${pad(hour)}:${pad(minute)} UTC`;
  if (everyDay) return `Every day at ${time}`;
  if (dom === '*') {
    const days = describeWeekdays(dow);
    return days ? `${days} at ${time}` : expression;
  }
  return dow === '*' && DIGITS.test(dom) ? `Day ${dom} of every month at ${time}` : expression;
}
