import { ruleParts } from './recurrence';
import type { EventDraft } from './types';

/** Format the wall-clock time as printed on the source — no zone conversion. */
export function formatWhen(event: EventDraft): string {
  if (!event.startDate) return '';
  const [y, m, d] = event.startDate.split('-').map(Number);
  const [hh, mm] = (event.startTime || '00:00').split(':').map(Number);
  const at = new Date(y, m - 1, d, hh, mm);
  if (Number.isNaN(at.getTime())) return event.startDate;

  const date = at.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: at.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
  if (event.allDay) return `${date} · all day`;

  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

const DAYS: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

const ORDINALS: Record<string, string> = {
  '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '5': 'fifth',
  '-1': 'last', '-2': 'second-to-last',
};

const nth = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const list = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** A plain-language gloss of an RRULE, so the repeat is reviewable too. */
export function describeRrule(rrule: string): string {
  if (!rrule) return '';
  const parts = ruleParts(rrule);

  const interval = Number(parts.INTERVAL || '1');
  const every: Record<string, string> = {
    DAILY: interval > 1 ? `every ${interval} days` : 'daily',
    WEEKLY: interval === 2 ? 'every other week' : interval > 1 ? `every ${interval} weeks` : 'weekly',
    MONTHLY: interval > 1 ? `every ${interval} months` : 'monthly',
    YEARLY: interval > 1 ? `every ${interval} years` : 'yearly',
  };

  let text = every[parts.FREQ] ?? 'repeating';
  if (parts.BYDAY) {
    // BYSETPOS with one weekday is "the nth of those days in the month".
    const setpos = parts.BYSETPOS && !parts.BYDAY.includes(',') ? parts.BYSETPOS : '';
    const days = parts.BYDAY.split(',').map((token) => {
      const match = /^(-?\d)?([A-Z]{2})$/.exec(token);
      if (!match) return token;
      const name = DAYS[match[2]] ?? token;
      const ordinal = match[1] || setpos;
      return ordinal ? `the ${ORDINALS[ordinal] ?? ordinal} ${name}` : name;
    });
    const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'];
    const workweek = parts.BYDAY.split(',').sort().join() === [...weekdays].sort().join();
    if (workweek && text === 'weekly') text = 'every weekday';
    else text += workweek ? ' on weekdays' : ` on ${list(days)}`;
  }
  if (parts.BYMONTHDAY) {
    const days = parts.BYMONTHDAY.split(',').map(Number).map((n) => (n === -1 ? 'the last day' : `the ${nth(n)}`));
    text += ` on ${list(days)}`;
  }
  if (parts.BYMONTH) {
    text += ` in ${list(parts.BYMONTH.split(',').map((m) => MONTHS[Number(m) - 1] ?? m))}`;
  }
  if (parts.COUNT) text += `, ${parts.COUNT} times`;
  if (parts.UNTIL) text += `, until ${parts.UNTIL.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`;
  return text;
}
