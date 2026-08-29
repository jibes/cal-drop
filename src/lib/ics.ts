import type { EventDraft } from './types';

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 requires lines of at most 75 octets, continued with a leading space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
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

function compactDate(date: string): string {
  return date.replace(/-/g, '');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function uid(event: EventDraft): string {
  return `${event.id}-${Math.random().toString(36).slice(2, 8)}@caldrop`;
}

function eventLines(event: EventDraft): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${uid(event)}`, `DTSTAMP:${stamp()}`];

  if (event.allDay) {
    // DTEND is exclusive for all-day events.
    const end = event.endDate || event.startDate;
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(end, 1))}`);
  } else {
    // Floating local time: the poster says "20:00", and that means 20:00
    // wherever the event is. No TZID, no UTC conversion, no silent shift.
    const startTime = event.startTime || '00:00';
    lines.push(`DTSTART:${compactDate(event.startDate)}T${startTime.replace(':', '')}00`);
    const endDate = event.endDate || event.startDate;
    const endTime = event.endTime || addHours(startTime, 2);
    const rolls = !event.endDate && endTime <= startTime;
    const finalDate = rolls ? addDays(endDate, 1) : endDate;
    lines.push(`DTEND:${compactDate(finalDate)}T${endTime.replace(':', '')}00`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  const description = [event.description, event.notes ? `Check: ${event.notes}` : '']
    .filter(Boolean)
    .join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push('END:VEVENT');
  return lines;
}

function addHours(time: string, hours: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = (h + hours) % 24;
  return `${String(total).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
