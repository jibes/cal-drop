import { zonedToUtc } from './tz';

/**
 * Repeat rules, as the model writes them and as calendars want them.
 *
 * The model is good at reading "every first Friday" into FREQ=MONTHLY;BYDAY=1FR
 * and less careful about the two things around it that a calendar takes
 * literally: the first date, and the date the rule ends.
 */

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export type RuleParts = Record<string, string>;

export function ruleParts(rrule: string): RuleParts {
  return Object.fromEntries(
    rrule
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split('=');
        return [k, v ?? ''];
      }),
  );
}

const joinRule = (parts: RuleParts): string =>
  Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

const utcDate = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Does this day count as an occurrence of the rule's day pattern? */
function matches(day: Date, parts: RuleParts): boolean {
  const days = (parts.BYDAY || '').split(',').filter(Boolean);
  const monthDays = (parts.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const weekday = DAY_CODES[day.getUTCDay()];
  const date = day.getUTCDate();
  const length = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();

  if (monthDays.length && !monthDays.some((n) => (n > 0 ? n === date : length + n + 1 === date))) return false;
  if (!days.length) return true;

  // BYSETPOS picks the nth of the matching days in a month; with one weekday
  // it is the same as an ordinal on the day itself.
  const setpos = parts.BYSETPOS ? Number(parts.BYSETPOS) : 0;
  return days.some((token) => {
    const m = /^(-?\d)?([A-Z]{2})$/.exec(token);
    if (!m || m[2] !== weekday) return false;
    const nth = m[1] ? Number(m[1]) : parts.FREQ === 'MONTHLY' ? setpos : 0;
    if (!nth) return true;
    const fromStart = Math.ceil(date / 7);
    const fromEnd = -Math.ceil((length - date + 1) / 7);
    return nth > 0 ? nth === fromStart : nth === fromEnd;
  });
}

/**
 * The first date on or after `startDate` that the rule actually produces.
 *
 * A calendar counts DTSTART as the first occurrence whatever the rule says,
 * so "every Tuesday, starting 1 October" written with 1 October — a
 * Thursday — puts one event on a Thursday and every other on Tuesdays. The
 * poster meant the first Tuesday. Only day patterns are moved: a rule with
 * none repeats from wherever it starts, which is correct by definition.
 */
export function firstOccurrence(startDate: string, rrule: string): string {
  if (!rrule || !startDate) return startDate;
  const parts = ruleParts(rrule);
  if (!parts.BYDAY && !parts.BYMONTHDAY) return startDate;
  if (!['WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ)) return startDate;
  const start = utcDate(startDate);
  if (Number.isNaN(start.getTime())) return startDate;
  // Every pattern here recurs within a year.
  for (let i = 0; i < 400; i++) {
    const day = new Date(start.getTime() + i * 86_400_000);
    if (parts.BYMONTH && !parts.BYMONTH.split(',').map(Number).includes(day.getUTCMonth() + 1)) continue;
    if (matches(day, parts)) return isoDate(day);
  }
  return startDate;
}

/**
 * An end date that is really the end of the series.
 *
 * "Every Saturday 8–13 until 19 December" has two ends, and the model puts
 * the series' into end_date as well as into UNTIL — which a calendar reads as
 * one market lasting from October to December. No single occurrence lasts as
 * long as the rule's own period, so an end that far away belongs to the rule:
 * it becomes UNTIL where there is none yet, and the event ends the day it
 * starts. A three-day festival every year keeps its three days.
 */
export function seriesEnd(
  startDate: string,
  endDate: string,
  rrule: string,
): { endDate: string; rrule: string } {
  if (!rrule || !endDate || !startDate) return { endDate, rrule };
  const parts = ruleParts(rrule);
  const interval = Number(parts.INTERVAL || '1') || 1;
  const period = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[parts.FREQ] ?? 0;
  if (!period || daysBetween(startDate, endDate) < period * interval) return { endDate, rrule };
  if (!parts.UNTIL && !parts.COUNT) parts.UNTIL = endDate.replace(/-/g, '');
  return { endDate: '', rrule: joinRule(parts) };
}

/** The days between two dates, for moving an end along with its start. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);

/**
 * The rule with its UNTIL in the form the event's start is in, as RFC 5545
 * requires and calendars enforce: a date for an all-day event, a UTC instant
 * for one written in UTC, local time for a floating one. The model writes
 * whichever it likes — usually a bare date — and a timed event with a date
 * UNTIL is one some calendars refuse outright. The last day is kept whole:
 * "until 19 December" includes the market on the 19th.
 */
export function ruleFor(
  rrule: string,
  start: { allDay: boolean; startTime: string; timezone: string },
  form: 'date' | 'utc' | 'floating',
): string {
  if (!rrule) return '';
  const parts = ruleParts(rrule);
  const until = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL || '');
  if (!until) return rrule;
  const day = `${until[1]}-${until[2]}-${until[3]}`;
  const compact = `${until[1]}${until[2]}${until[3]}`;
  if (form === 'date' || start.allDay) {
    parts.UNTIL = compact;
  } else if (form === 'floating') {
    parts.UNTIL = `${compact}T235959`;
  } else {
    const at = zonedToUtc(day, '23:59', start.timezone) ?? localEndOfDay(day);
    parts.UNTIL = `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  }
  return joinRule(parts);
}

/** 23:59 on that day where this device is, for an event with no zone of its own. */
function localEndOfDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59);
}
