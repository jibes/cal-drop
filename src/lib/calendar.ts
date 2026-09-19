import { addDays, icsLink, resolvedEnd } from './ics';
import { localZone, zonedToUtc } from './tz';
import type { EventDraft } from './types';

/**
 * Deep links into the user's calendar. A downloaded .ics is a file the phone
 * then has to find a handler for; these open the calendar app itself with the
 * event already filled in, which is one tap instead of five.
 */

const compact = (date: string, time: string) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;

function googleRange(event: EventDraft): string {
  if (event.allDay) {
    // Google treats the end of an all-day range as exclusive, same as ICS.
    const end = addDays(event.endDate || event.startDate, 1);
    return `${event.startDate.replace(/-/g, '')}/${end.replace(/-/g, '')}`;
  }
  const end = resolvedEnd(event);
  return `${compact(event.startDate, event.startTime)}/${compact(end.date, end.time)}`;
}

function details(event: EventDraft): string {
  return [
    event.description,
    event.url,
    event.sourceText ? `Read from: "${event.sourceText}"` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function googleCalendarUrl(event: EventDraft): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: googleRange(event),
    details: details(event),
    location: event.location,
    ctz: event.timezone || localZone(),
  });
  if (event.rrule) params.set('recur', `RRULE:${event.rrule}`);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function outlookCalendarUrl(event: EventDraft): string {
  const iso = (date: string, time: string) => `${date}T${time || '00:00'}:00`;
  const end = resolvedEnd(event);
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: event.allDay ? event.startDate : iso(event.startDate, event.startTime),
    enddt: event.allDay ? addDays(event.endDate || event.startDate, 1) : iso(end.date, end.time),
    body: details(event),
    location: event.location,
    ...(event.allDay ? { allday: 'true' } : {}),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** The instant a wall-clock time names: in the venue's zone when one is known,
 *  otherwise in the zone of whoever is reading the poster. */
function instant(date: string, time: string, timezone: string): number {
  const zoned = timezone ? zonedToUtc(date, time, timezone) : null;
  if (zoned) return zoned.getTime();
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/**
 * Android's own "add an event" intent.
 *
 * Asking Android to VIEW a text/calendar file resolves to whatever registered
 * for that type — an .ics importer, a subscription manager, anything — because
 * the question was about a file format. ACTION_INSERT on an event is answered
 * only by apps that keep a calendar, which is the actual intent, and it names
 * no vendor: whichever calendar the person uses opens with the event filled in.
 */
/** The extras an insert intent carries, shared by the variants below. */
function insertExtras(event: EventDraft): string[] {
  const end = resolvedEnd(event);
  const begin = event.allDay
    ? instant(event.startDate, '00:00', '')
    : instant(event.startDate, event.startTime, event.timezone);
  const finish = event.allDay
    ? instant(addDays(event.endDate || event.startDate, 1), '00:00', '')
    : instant(end.date, end.time, event.timezone);

  const extras = [
    `S.title=${encodeURIComponent(event.title)}`,
    `l.beginTime=${begin}`,
    `l.endTime=${finish}`,
    `B.allDay=${event.allDay}`,
  ];
  if (event.location) extras.push(`S.eventLocation=${encodeURIComponent(event.location)}`);
  if (event.rrule) extras.push(`S.rrule=${encodeURIComponent(event.rrule)}`);
  const description = [event.description, event.url].filter(Boolean).join('\n\n');
  if (description) extras.push(`S.description=${encodeURIComponent(description)}`);
  return extras;
}

/**
 * The ways of asking Android to add an event, so a device can say which one it
 * honours. Chromium parses an intent URI with or without a host, and a host
 * becomes the intent's data, which changes how it resolves — that difference
 * cannot be reasoned out from here, only tried.
 */
export function calendarHandoffVariants(event: EventDraft): { label: string; href: string }[] {
  const extras = insertExtras(event).join(';');
  const file = icsLink([event]);
  return [
    {
      label: 'A  insert event (no host)',
      href: `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/event;${extras};end`,
    },
    {
      label: 'B  insert event (with host)',
      href: `intent://event#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/event;${extras};end`,
    },
    {
      label: 'C  insert event, calendar content URI',
      href: `intent://com.android.calendar/events#Intent;scheme=content;action=android.intent.action.INSERT;${extras};end`,
    },
    { label: 'D  the .ics file over https', href: file || '(no endpoint configured)' },
  ];
}

export function androidCalendarIntent(event: EventDraft): string {
  const extras = insertExtras(event);
  // If no calendar app answers, fall back to the file rather than an error.
  const fallback = icsLink([event]);
  if (fallback) extras.push(`S.browser_fallback_url=${encodeURIComponent(fallback)}`);

  return `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/event;${extras.join(';')};end`;
}

/** Neither deep link carries an exception list, so recurrence is best-effort. */
export function deeplinkCaveat(event: EventDraft): string {
  return event.rrule
    ? 'Deep links may drop the repeat rule — use the .ics for recurring events.'
    : '';
}
