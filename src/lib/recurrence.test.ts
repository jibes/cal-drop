import { describe, expect, it } from 'vitest';
import { normalizeRrule } from './ai';
import { buildIcs } from './ics';
import { describeRrule } from './format';
import { insertPayload } from './native';
import { firstOccurrence, ruleFor, seriesEnd } from './recurrence';
import type { EventDraft } from './types';

const event = (over: Partial<EventDraft>): EventDraft => ({
  id: 'e',
  title: 'Lauftreff',
  startDate: '2026-10-06',
  startTime: '19:00',
  endDate: '',
  endTime: '',
  allDay: false,
  location: '',
  timezone: '',
  rrule: '',
  description: '',
  url: '',
  sourceText: '',
  confidence: 1,
  notes: '',
  ...over,
});

describe('the first occurrence', () => {
  it('moves "every Tuesday from 1 October" (a Thursday) to the first Tuesday', () => {
    expect(firstOccurrence('2026-10-01', 'FREQ=WEEKLY;BYDAY=TU')).toBe('2026-10-06');
  });

  it('leaves a start that is already an occurrence where it is', () => {
    expect(firstOccurrence('2026-10-06', 'FREQ=WEEKLY;BYDAY=TU')).toBe('2026-10-06');
    expect(firstOccurrence('2026-10-07', 'FREQ=WEEKLY;BYDAY=WE,FR')).toBe('2026-10-07');
  });

  it('finds the first Friday, the last Sunday and the 15th of a month', () => {
    expect(firstOccurrence('2026-10-03', 'FREQ=MONTHLY;BYDAY=1FR')).toBe('2026-11-06');
    expect(firstOccurrence('2026-10-02', 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1')).toBe('2026-10-02');
    expect(firstOccurrence('2026-10-02', 'FREQ=MONTHLY;BYDAY=-1SU')).toBe('2026-10-25');
    expect(firstOccurrence('2026-10-16', 'FREQ=MONTHLY;BYMONTHDAY=15')).toBe('2026-11-15');
  });

  it('does not touch a rule with no day pattern', () => {
    expect(firstOccurrence('2026-10-01', 'FREQ=WEEKLY')).toBe('2026-10-01');
    expect(firstOccurrence('2026-06-21', 'FREQ=YEARLY')).toBe('2026-06-21');
  });
});

describe('the end of a rule', () => {
  const timed = { allDay: false, startTime: '08:00', timezone: 'Europe/Zurich' };

  it('is a date for an all-day event', () => {
    expect(ruleFor('FREQ=WEEKLY;UNTIL=20261219T000000Z', { ...timed, allDay: true }, 'utc')).toBe('FREQ=WEEKLY;UNTIL=20261219');
  });

  it('is the last minute of that day, in UTC, for an event in a known zone', () => {
    expect(ruleFor('FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219', timed, 'utc')).toBe('FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219T225900Z');
  });

  it('is local time for a floating event', () => {
    expect(ruleFor('FREQ=WEEKLY;UNTIL=20261219', { ...timed, timezone: '' }, 'floating')).toBe('FREQ=WEEKLY;UNTIL=20261219T235959');
  });

  it('reaches the calendar file, the phone and nothing else changes', () => {
    const market = event({ startTime: '08:00', timezone: 'Europe/Zurich', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219' });
    expect(buildIcs([market])).toContain('RRULE:FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219T225900Z');
    expect(insertPayload(market).rrule).toBe('FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219T225900Z');
    expect(buildIcs([event({ rrule: 'FREQ=WEEKLY;COUNT=8' })])).toContain('RRULE:FREQ=WEEKLY;COUNT=8');
  });
});

describe('the repeat in words', () => {
  it.each([
    ['FREQ=WEEKLY;BYDAY=TU', 'weekly on Tuesday'],
    ['FREQ=WEEKLY;BYDAY=WE,FR;COUNT=8', 'weekly on Wednesday and Friday, 8 times'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', 'every other week on Saturday'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'every weekday'],
    ['FREQ=MONTHLY;BYDAY=1FR', 'monthly on the first Friday'],
    ['FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1', 'monthly on the first Friday'],
    ['FREQ=MONTHLY;BYDAY=-1SU', 'monthly on the last Sunday'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', 'monthly on the 15th'],
    ['FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=21', 'yearly on the 21st in June'],
    ['FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219', 'weekly on Saturday, until 2026-12-19'],
  ])('%s', (rule, words) => {
    expect(describeRrule(rule)).toBe(words);
  });
});

describe('a rule as the model writes it', () => {
  it.each([
    ['FREQ=YEARLY;MONTH=6;DAY=21', 'FREQ=YEARLY'],
    ['RRULE:freq=weekly;byday=tu', 'FREQ=WEEKLY;BYDAY=TU'],
    ['FREQ=MONTHLY;BYDAY=+1FR', 'FREQ=MONTHLY;BYDAY=1FR'],
    ['FREQ=WEEKLY;COUNT=8;UNTIL=20261231', 'FREQ=WEEKLY;COUNT=8'],
    ['FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z', 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z'],
    ['BYDAY=TU;FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=TU'],
    ['every Tuesday', ''],
  ])('%s', (raw, kept) => {
    expect(normalizeRrule(raw)).toBe(kept);
  });
});

describe('an end that is the end of the series', () => {
  it('moves into the rule, and the market lasts a morning again', () => {
    expect(seriesEnd('2026-10-03', '2026-12-19', 'FREQ=WEEKLY;BYDAY=SA')).toEqual({ endDate: '', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219' });
    expect(seriesEnd('2026-10-03', '2026-12-19', 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219T235959Z')).toEqual({
      endDate: '',
      rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261219T235959Z',
    });
  });

  it('leaves an event that really lasts several days', () => {
    expect(seriesEnd('2027-06-18', '2027-06-20', 'FREQ=YEARLY')).toEqual({ endDate: '2027-06-20', rrule: 'FREQ=YEARLY' });
    expect(seriesEnd('2026-10-03', '2026-10-04', 'FREQ=WEEKLY;BYDAY=SA')).toEqual({ endDate: '2026-10-04', rrule: 'FREQ=WEEKLY;BYDAY=SA' });
  });
});
