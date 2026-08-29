import { addDays, resolvedEnd } from './ics';
import { localZone } from './tz';
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

/** Neither deep link carries an exception list, so recurrence is best-effort. */
export function deeplinkCaveat(event: EventDraft): string {
  return event.rrule
    ? 'Deep links may drop the repeat rule — use the .ics for recurring events.'
    : '';
}
