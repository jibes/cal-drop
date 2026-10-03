import { buildIcs, icsName, resolvedEnd } from './ics';
import { ruleFor } from './recurrence';
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
  /** Likewise. Puts the file in Downloads instead of handing it to an app. */
  saveFile?(file: { name: string; content: string }): Promise<{ saved: string }>;
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
    // Android's calendars store a timed event's repeat end as a UTC instant.
    rrule: ruleFor(event.rrule, event, event.allDay ? 'date' : 'utc'),
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

/**
 * The same file, kept instead of handed on.
 *
 * A browser downloads by following a link the server marks as an attachment;
 * a web view inside an app has nowhere to put one, so the shell writes it to
 * the phone's Downloads itself. Returns where it landed, or '' where there is
 * no shell to ask — in which case the caller asks the endpoint for it instead.
 */
export async function saveCalendarFileInApp(events: EventDraft[]): Promise<string> {
  const save = plugin()?.saveFile;
  if (!save || events.length === 0) return '';
  try {
    const { saved } = await save.call(plugin(), { name: icsName(events), content: buildIcs(events) });
    return saved || '';
  } catch {
    return '';
  }
}

/**
 * A page, read by the device rather than by the page.
 *
 * The same-origin policy is the browser's rule, and inside the shell there is
 * no browser doing the asking: Capacitor's HTTP goes through the platform's
 * own stack, where a site that offers no CORS headers is simply a site. So
 * fetching a link, which a browser needs a service for, the app can do for
 * itself.
 *
 * Deliberately called rather than switched on. Capacitor can be configured to
 * patch window.fetch so every request goes this way, which would quietly
 * break the extraction: it reads the model's answer as it arrives, and the
 * native path returns the body whole. Only this one request is handed over.
 */
const MAX_PAGE = 1024 * 1024;

interface NativeHttp {
  request(options: {
    url: string;
    method?: string;
    responseType?: string;
    connectTimeout?: number;
    readTimeout?: number;
  }): Promise<{ data: unknown; status: number; headers: Record<string, string> }>;
}

const http = (): NativeHttp | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { CapacitorHttp?: NativeHttp } } }).Capacitor?.Plugins
    ?.CapacitorHttp;

export const canReadPagesNatively = (): boolean => Boolean(http());

/**
 * Running inside the shell rather than in a browser tab. Worth knowing where
 * the advice differs: a page may not call an API that offers it no CORS
 * headers, and the app is under no such rule.
 */
export function inNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: object } })
    .Capacitor;
  if (typeof cap?.isNativePlatform === 'function') return cap.isNativePlatform();
  return Boolean(cap?.Plugins);
}

export async function readPageNatively(url: string): Promise<string> {
  const bridge = http();
  if (!bridge) return '';
  const res = await bridge.request({
    url,
    method: 'GET',
    responseType: 'text',
    connectTimeout: 15000,
    readTimeout: 15000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`That page answered with HTTP ${res.status}.`);
  }
  const type = headerValue(res.headers, 'content-type');
  if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    throw new Error(`That link is ${type.split(';')[0]}, not a page with text in it.`);
  }
  const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
  return htmlToText(body.slice(0, MAX_PAGE));
}

/** Header names arrive in whatever case the server chose. */
function headerValue(headers: Record<string, string>, name: string): string {
  const found = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return found ? headers[found] : '';
}

/**
 * The words a reader would see. Parsed rather than stripped with patterns:
 * the browser has a real HTML parser, it does not run anything in a document
 * made this way, and nothing here is ever put back into the live page.
 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg, template, nav, footer, header, aside').forEach(
    (el) => el.remove(),
  );
  doc.querySelectorAll('br, p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach((el) =>
    el.after(doc.createTextNode('\n')),
  );
  return (doc.body?.textContent ?? '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- API requests made by the app rather than its page ----

interface StreamingHttp {
  request(options: { id: string; url: string; method: string; headers: Record<string, string>; body: string | null }): Promise<void>;
  abort(options: { id: string }): Promise<void>;
  addListener(event: 'head' | 'chunk' | 'end' | 'error', handler: (data: StreamEvent) => void): unknown;
}

interface StreamEvent {
  id: string;
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  message?: string;
}

const streaming = (): StreamingHttp | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { StreamingHttp?: StreamingHttp } } }).Capacitor?.Plugins?.StreamingHttp;

/** Whether this app can make a request that no CORS rule applies to, and hand it back as it arrives. */
export const canFetchNatively = (): boolean => Boolean(streaming());

interface InFlight {
  head(status: number, headers: Record<string, string>): void;
  chunk(data: string): void;
  end(): void;
  fail(message: string): void;
}

const inFlight = new Map<string, InFlight>();
let listening = false;

/** One set of listeners for every request, routed by the id each event carries. */
function listen(plugin: StreamingHttp): void {
  if (listening) return;
  listening = true;
  // Through Capacitor.Plugins, addListener hands back an id rather than a
  // promise — see share.ts — so nothing is chained on it.
  plugin.addListener('head', (e) => inFlight.get(e.id)?.head(e.status ?? 0, e.headers ?? {}));
  plugin.addListener('chunk', (e) => inFlight.get(e.id)?.chunk(e.data ?? ''));
  plugin.addListener('end', (e) => inFlight.get(e.id)?.end());
  plugin.addListener('error', (e) => inFlight.get(e.id)?.fail(e.message ?? 'The request failed.'));
}

/**
 * fetch(), made by the app. The answer is an ordinary Response whose body
 * arrives as the server sends it, so everything that reads a streamed answer
 * reads this one the same way. A failure before any answer rejects with a
 * TypeError, as fetch() does; an abort with an AbortError.
 */
export function nativeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const plugin = streaming();
  if (!plugin) return fetch(url, init);
  listen(plugin);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void plugin.abort({ id }),
  });

  return new Promise<Response>((resolve, reject) => {
    let answered = false;
    const done = () => inFlight.delete(id);
    const stop = (error: Error) => {
      done();
      if (!answered) reject(error);
      else {
        try {
          controller?.error(error);
        } catch {
          /* already closed */
        }
      }
    };
    inFlight.set(id, {
      head: (status, headers) => {
        answered = true;
        // A status the Response constructor refuses (a bare 1xx, say) is no answer.
        try {
          resolve(new Response(body, { status, headers }));
        } catch {
          stop(new TypeError(`The API answered with status ${status}.`));
        }
      },
      chunk: (data) => controller?.enqueue(encoder.encode(data)),
      end: () => {
        done();
        try {
          controller?.close();
        } catch {
          /* cancelled by the reader */
        }
      },
      fail: (message) => stop(new TypeError(message)),
    });

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        stop(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        void plugin.abort({ id });
        stop(new DOMException('Aborted', 'AbortError'));
      });
    }

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    plugin
      .request({ id, url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : null })
      .catch((err: unknown) => stop(new TypeError((err as Error)?.message ?? 'The request could not be made.')));
  });
}

interface OrientationPlugin {
  allowLandscape(o: { allowed: boolean }): Promise<void>;
}

/**
 * Let the screen turn sideways, or hold it upright. The app is upright
 * everywhere but in the camera, where a wide poster wants a wide frame; a
 * browser decides this for itself, so there it does nothing.
 */
export function allowLandscape(allowed: boolean): void {
  const orientation = (globalThis as { Capacitor?: { Plugins?: { Orientation?: OrientationPlugin } } }).Capacitor
    ?.Plugins?.Orientation;
  void Promise.resolve(orientation?.allowLandscape({ allowed })).catch(() => undefined);
}
