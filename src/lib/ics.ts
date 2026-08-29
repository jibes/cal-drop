import { zonedToUtc } from './tz';
import type { EventDraft } from './types';

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 requires lines of at most 75 octets, continued with a leading space. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

const compactDate = (date: string) => date.replace(/-/g, '');

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addHours(time: string, hours: number): string {
  const [h, m] = time.split(':').map(Number);
  return `${String((h + hours) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The end a user did not supply: two hours later, rolling past midnight. */
export function resolvedEnd(event: EventDraft): { date: string; time: string } {
  const time = event.endTime || addHours(event.startTime || '00:00', 2);
  if (event.endDate) return { date: event.endDate, time };
  const rolls = time <= (event.startTime || '00:00');
  return { date: rolls ? addDays(event.startDate, 1) : event.startDate, time };
}

const utcStamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

function eventLines(event: EventDraft): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}-${Math.random().toString(36).slice(2, 8)}@caldrop`,
    `DTSTAMP:${utcStamp(new Date())}`,
  ];

  if (event.allDay) {
    // DTEND is exclusive for all-day events.
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(event.endDate || event.startDate, 1))}`);
  } else {
    const end = resolvedEnd(event);
    const startUtc = event.timezone
      ? zonedToUtc(event.startDate, event.startTime, event.timezone)
      : null;
    const endUtc = event.timezone ? zonedToUtc(end.date, end.time, event.timezone) : null;

    if (startUtc && endUtc) {
      // A venue's zone is known, so the event names a real instant. Writing it
      // in UTC is exact everywhere and needs no VTIMEZONE block to travel.
      lines.push(`DTSTART:${utcStamp(startUtc)}`);
      lines.push(`DTEND:${utcStamp(endUtc)}`);
    } else {
      // Floating local time: "20:00" on a poster means 20:00 where the event is.
      lines.push(`DTSTART:${compactDate(event.startDate)}T${event.startTime.replace(':', '')}00`);
      lines.push(`DTEND:${compactDate(end.date)}T${end.time.replace(':', '')}00`);
    }
  }

  if (event.rrule) lines.push(`RRULE:${event.rrule}`);
  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);

  const description = [
    event.description,
    event.notes ? `Check: ${event.notes}` : '',
    event.sourceText ? `Read from: "${event.sourceText}"` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (event.url) lines.push(`URL:${event.url}`);

  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(events: EventDraft[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CalDrop//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flatMap(eventLines),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'event'
  );
}

export function downloadIcs(events: EventDraft[]): void {
  const name = events.length === 1 ? slug(events[0].title) : 'events';
  const blob = new Blob([buildIcs(events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
