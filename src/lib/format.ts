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

/** A plain-language gloss of an RRULE, so the repeat is reviewable too. */
export function describeRrule(rrule: string): string {
  if (!rrule) return '';
  const parts = Object.fromEntries(
    rrule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k, v ?? ''];
    }),
  );

  const interval = Number(parts.INTERVAL || '1');
  const every: Record<string, string> = {
    DAILY: interval > 1 ? `every ${interval} days` : 'daily',
    WEEKLY: interval > 1 ? `every ${interval} weeks` : 'weekly',
    MONTHLY: interval > 1 ? `every ${interval} months` : 'monthly',
    YEARLY: interval > 1 ? `every ${interval} years` : 'yearly',
  };

  let text = every[parts.FREQ] ?? 'repeating';
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',')
      .map((token) => {
        const match = /^(-?\d)?([A-Z]{2})$/.exec(token);
        if (!match) return token;
        const name = DAYS[match[2]] ?? token;
        const ordinal = match[1];
        if (!ordinal) return name;
        return ordinal === '-1' ? `last ${name}` : `${['', '1st', '2nd', '3rd', '4th'][Number(ordinal)] ?? ordinal} ${name}`;
      })
      .join(', ');
    text += ` on ${days}`;
  }
  if (parts.COUNT) text += `, ${parts.COUNT} times`;
  if (parts.UNTIL) text += `, until ${parts.UNTIL.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`;
  return text;
}
