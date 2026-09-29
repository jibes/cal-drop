import { buildIcs, icsName, resolvedEnd } from './ics';
import { zonedToUtc } from './tz';
import type { EventDraft } from './types';

/**
 * The calendar an app can open and a web page cannot.
 *
 * Running inside the native shell there is a plugin that fires Android's
 * ACTION_INSERT: the calendar the person actually uses opens with the event
 * filled in, repeat rule included. In a browser there is no such plugin and
 * this reports itself unavailable, which is how the page stays a page — one
 * implementation, one extra door where the door exists.
 */

interface CalendarInsert {
  available(): Promise<{ available: boolean }>;
  insert(event: InsertPayload): Promise<{ opened: boolean }>;
  /** Absent in shells built before it existed. */
  openFile?(file: { name: string; content: string }): Promise<{ opened: string }>;
}

interface InsertPayload {
  title: string;
  begin: number;
  end: number;
  allDay: boolean;
  location: string;
  description: string;
  rrule: string;
  timezone: string;
}

/** Capacitor publishes every registered native plugin here; a browser has no
 *  such object, and that is the whole feature test. */
const plugin = (): CalendarInsert | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { CalendarInsert?: CalendarInsert } } }).Capacitor?.Plugins
    ?.CalendarInsert;

export async function calendarAppAvailable(): Promise<boolean> {
  try {
    return (await plugin()?.available())?.available === true;
  } catch {
    return false;
  }
}

/**
 * The instant a wall-clock time names: in the venue's zone when the poster
 * said enough to know it, otherwise in the zone of whoever is reading it.
 */
function instant(date: string, time: string, timezone: string): number {
  const zoned = timezone ? zonedToUtc(date, time, timezone) : null;
  if (zoned) return zoned.getTime();
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/** Midnight UTC of a date. Android wants all-day events at UTC midnight, not
 *  at local midnight — sent local, a phone west of Greenwich files a festival
 *  on the day before it happens. */
function utcMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function insertPayload(event: EventDraft): InsertPayload {
  const end = resolvedEnd(event);
  return {
    title: event.title,
    begin: event.allDay
      ? utcMidnight(event.startDate)
      : instant(event.startDate, event.startTime, event.timezone),
    // The last day itself, not the midnight after it. A stored all-day event
    // ends exclusively, but a calendar's "new event" screen reads this extra
    // as the day it ends on: sent the next midnight, Simple Calendar opened a
    // one-day event as two days, from the Saturday to the Sunday.
    end: event.allDay
      ? utcMidnight(event.endDate || event.startDate)
      : instant(end.date, end.time, event.timezone),
    allDay: event.allDay,
    location: event.location,
    description: [event.description, event.url].filter(Boolean).join('\n\n'),
    rrule: event.rrule,
    timezone: event.timezone,
  };
}

/** True when a calendar opened. False means nothing answered, and the caller
 *  should fall back to handing over the file. */
export async function addToCalendarApp(event: EventDraft): Promise<boolean> {
  const bridge = plugin();
  if (!bridge) return false;
  try {
    return (await bridge.insert(insertPayload(event))).opened === true;
  } catch {
    return false;
  }
}

/**
 * The calendar file, opened by the app rather than downloaded by a browser.
 * True when something took it — a calendar, or the share sheet; false where
 * there is no shell to ask, and the caller hands over the link instead.
 */
export async function openCalendarFileInApp(events: EventDraft[]): Promise<boolean> {
  const open = plugin()?.openFile;
  if (!open || events.length === 0) return false;
  try {
    const { opened } = await open.call(plugin(), { name: icsName(events), content: buildIcs(events) });
    return Boolean(opened);
  } catch {
    return false;
  }
}
