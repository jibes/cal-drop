/** Milliseconds that `tz` is ahead of UTC at the given instant. */
function offsetAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

export function isValidZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a wall-clock date and time in `tz` into the instant it names.
 * Two passes, because the offset itself depends on the instant we are solving
 * for — one iteration lands on the right side of a DST boundary.
 */
export function zonedToUtc(date: string, time: string, tz: string): Date | null {
  if (!isValidZone(tz)) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  if (!y || !mo || !d) return null;

  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    instant = wall - offsetAt(new Date(instant), tz);
  }
  return new Date(instant);
}

/** The viewer's own zone, used as the fallback when a poster names no venue. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}
