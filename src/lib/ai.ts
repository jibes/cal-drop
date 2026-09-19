import { endpoint } from './settings';
import { isValidZone, localZone } from './tz';
import type { EventDraft, ExtractionSource, Settings } from './types';

export const SYSTEM_PROMPT = `You extract calendar events from event posters, flyers, screenshots, PDFs and web pages.

Rules:
- Return ONLY events that actually take place, with a concrete date. Ignore printing dates, ticket-sale dates, imprint/copyright years and a venue's general opening hours.
- Dates are usually written in the source's own language and locale. German/European sources use day.month.year; US sources use month/day/year. Use the surrounding language to decide.
- If a source gives a weekday and a day/month but no year, pick the year that makes the weekday match, preferring the nearest such date that is not in the past relative to the reference date given by the user.
- Times may be written as "20 Uhr", "8pm", "20:00", "Einlass 19:00 / Beginn 20:00". Use the start of the event itself, and mention a doors time in the description.
- If only a date and no time is given, set all_day true.
- A source may list several events (a festival programme, a series). Return each as its own object.
- For a recurring event ("every Tuesday", "jeden ersten Freitag im Monat") set rrule to an RFC 5545 recurrence rule body and set start_date to the first occurrence.
- Set timezone to the IANA zone of the venue when the place is clear enough to know it (Berlin venue -> Europe/Berlin). Leave it empty if you are guessing.
- source_text must quote, verbatim, the words you read the date and time from. Never paraphrase it.
- Never invent a date. If no date can be read, return an empty list.`;

const EVENT_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start_date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM in 24h, or empty' },
          end_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
          end_time: { type: 'string', description: 'HH:MM in 24h, or empty' },
          all_day: { type: 'boolean' },
          location: { type: 'string' },
          timezone: { type: 'string', description: 'IANA zone, or empty' },
          rrule: { type: 'string', description: 'RFC 5545 RRULE body, or empty' },
          description: { type: 'string' },
          url: { type: 'string' },
          source_text: { type: 'string', description: 'verbatim quote the date was read from' },
          confidence: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['title', 'start_date', 'all_day', 'source_text', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
} as const;

interface RawEvent {
  title?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  all_day?: boolean;
  location?: string;
  timezone?: string;
  rrule?: string;
  description?: string;
  url?: string;
  source_text?: string;
  confidence?: number;
  notes?: string;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * How to ask, most capable first, each rung giving up one thing the previous
 * one assumed. Servers differ on what they accept and on how they refuse:
 * some answer 400, some answer 200 with an error event, some accept a
 * parameter and quietly ignore it. None of that is visible in advance, so the
 * ladder is walked rather than chosen.
 *
 * The last rung is the barest request the API allows — no tools, no
 * response_format, no system role, not even a temperature — because some
 * models have no system turn at all (Gemma's template is user/model only) and
 * strict servers reject one as malformed.
 */
interface Rung {
  structured: 'tools' | 'json' | 'none';
  /** 'role' sends a system message; 'merged' folds it into the user turn. */
  system: 'role' | 'merged';
  temperature: boolean;
}

const LADDER: Rung[] = [
  { structured: 'tools', system: 'role', temperature: true },
  { structured: 'json', system: 'role', temperature: true },
  { structured: 'none', system: 'role', temperature: true },
  { structured: 'none', system: 'merged', temperature: false },
];

const MODE_KEY = 'caldrop.endpointMode.v1';

/** The endpoint's quirks do not change between requests, so pay for finding
 *  them once and start there next time. */
function rememberedRung(): number {
  try {
    const i = Number(localStorage.getItem(MODE_KEY));
    return Number.isInteger(i) && i >= 0 && i < LADDER.length ? i : 0;
  } catch {
    return 0;
  }
}

function rememberRung(i: number): void {
  try {
    localStorage.setItem(MODE_KEY, String(i));
  } catch {
    /* storage disabled; we just re-learn each time */
  }
}

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Called with the best-known title/date while the response is still arriving. */
  onProgress?: (preview: { title: string; date: string }) => void;
}

const NO_ENDPOINT =
  'This build has no endpoint configured, so there is nothing for it to call. ' +
  'VITE_PROXY_URL was empty when it was built.';

const chatUrl = () =>
  endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;

/**
 * fetch() rejects with a bare "Failed to fetch" for every network-level
 * failure, CORS included — and CORS is by far the likeliest one here, because
 * an API key plus a JSON content type forces a preflight that most inference
 * endpoints never answer. The browser logs the real reason to the console and
 * refuses to expose it to script, so spell out the likely cause and the fix.
 */
function describeNetworkFailure(): string {
  if (!endpoint) return NO_ENDPOINT;
  let host = endpoint;
  try {
    host = new URL(chatUrl()).host;
  } catch {
    /* an unconfigured endpoint is its own answer */
  }
  return [
    `Could not reach ${host} — the request never left the browser.`,
    `Either you are offline, that endpoint is not answering, or it is not configured to serve ${location.origin}.`,
  ].join('\n');
}

/**
 * Content is a plain string unless there are images to attach. The array form
 * is valid everywhere in theory, but a number of servers only accept it when
 * it actually carries an image, and reject a text-only array as malformed.
 */
function buildUserContent(source: ExtractionSource, withImages: boolean): string | ContentPart[] {
  const today = new Date().toISOString().slice(0, 10);
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: `Reference date (today): ${today}. Viewer timezone: ${localZone() || 'unknown'}. Source: ${source.label} (${source.kind}).\n\nExtract every event with its date.`,
    },
  ];
  if (source.text.trim()) {
    parts.push({ type: 'text', text: `--- source text ---\n${source.text.slice(0, 60000)}` });
  }
  if (!withImages || source.images.length === 0) {
    return parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
  }
  for (const url of source.images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * Pull a title and date out of a half-arrived JSON buffer. A tolerant regex
 * beats a partial-JSON parser here: we only need something to show, and the
 * authoritative parse happens once the stream closes.
 */
function previewFrom(buffer: string): { title: string; date: string } {
  const title = /"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(buffer)?.[1] ?? '';
  const date = /"start_date"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(buffer)?.[1] ?? '';
  return { title: title.replace(/\\"/g, '"'), date };
}

function parseJson(content: string): { events?: RawEvent[] } {
  const cleaned = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The model did not return JSON.');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function normalizeTime(v: string | undefined): string {
  if (!v) return '';
  const m = /^(\d{1,2})[:.]?(\d{2})?/.exec(v.trim());
  if (!m) return '';
  const h = Math.min(23, Number(m[1]));
  const min = Math.min(59, Number(m[2] ?? '0'));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function normalizeDate(v: string | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Accept only rules built from the parts we render and export. */
function normalizeRrule(v: string | undefined): string {
  if (!v) return '';
  const body = v.trim().replace(/^RRULE:/i, '').toUpperCase();
  if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(body)) return '';
  return /^[A-Z0-9=;,+-]+$/.test(body) ? body : '';
}

function toDraft(raw: RawEvent, i: number): EventDraft {
  const startTime = normalizeTime(raw.start_time);
  const timezone = (raw.timezone || '').trim();
  return {
    id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    title: (raw.title || 'Untitled event').trim(),
    startDate: normalizeDate(raw.start_date),
    startTime,
    endDate: normalizeDate(raw.end_date),
    endTime: normalizeTime(raw.end_time),
    allDay: raw.all_day === true || !startTime,
    location: (raw.location || '').trim(),
    timezone: isValidZone(timezone) ? timezone : '',
    rrule: normalizeRrule(raw.rrule),
    description: (raw.description || '').trim(),
    url: (raw.url || '').trim(),
    sourceText: (raw.source_text || '').trim(),
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    notes: (raw.notes || '').trim(),
  };
}

interface StreamDelta {
  content?: string;
  tool_calls?: { function?: { arguments?: string } }[];
}

/** Read an SSE stream, accumulating whichever channel the model chose to answer on. */
/**
 * Pull the answer out of a whole, non-streamed completion. Plenty of
 * OpenAI-compatible servers accept `stream: true` and answer with an ordinary
 * JSON body anyway, which an SSE reader skips entirely and reports as nothing.
 */
function fromCompletion(raw: string): string {
  try {
    const message = (
      JSON.parse(raw) as {
        choices?: { message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[];
      }
    ).choices?.[0]?.message;
    return message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? '';
  } catch {
    return '';
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: ExtractOptions['onProgress'],
): Promise<{ text: string; raw: string; error: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let out = '';
  let error = '';
  let lastPreview = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let event: { choices?: { delta?: StreamDelta }[]; error?: { message?: string } } | undefined;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      // A refusal can arrive as an event on a 200 response, so the status code
      // never sees it; without this it reads as an answer containing nothing.
      if (event?.error?.message) error = event.error.message;
      const delta = event?.choices?.[0]?.delta;
      out += delta?.tool_calls?.[0]?.function?.arguments ?? delta?.content ?? '';
    }

    if (onProgress) {
      const preview = previewFrom(out);
      const key = `${preview.title}|${preview.date}`;
      if (preview.title && key !== lastPreview) {
        lastPreview = key;
        onProgress(preview);
      }
    }
  }
  // An answer that never streamed is still an answer.
  return { text: out.trim() ? out : fromCompletion(raw), raw, error };
}

function messagesFor(rung: Rung, content: string | ContentPart[]) {
  if (rung.system === 'role') {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ];
  }
  // No system turn: the instructions lead the user message instead.
  const merged =
    typeof content === 'string'
      ? `${SYSTEM_PROMPT}\n\n---\n\n${content}`
      : [{ type: 'text' as const, text: SYSTEM_PROMPT }, ...content];
  return [{ role: 'user', content: merged }];
}

async function callModel(
  content: string | ContentPart[],
  settings: Settings,
  attempt: number,
  options: ExtractOptions,
): Promise<string> {
  const rung = LADDER[attempt];
  if (!endpoint) throw new Error(NO_ENDPOINT);

  const code = settings.accessCode.trim();
  let res: Response;
  try {
    res = await fetch(chatUrl(), {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(code ? { Authorization: `Bearer ${code}` } : {}),
      },
      body: JSON.stringify({
        // No model: the endpoint decides which one answers.
        stream: true,
        messages: messagesFor(rung, content),
        ...(rung.temperature ? { temperature: 0 } : {}),
        ...(rung.structured === 'tools'
          ? {
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'save_events',
                    description: 'Save every event found in the source.',
                    parameters: EVENT_SCHEMA,
                  },
                },
              ],
              tool_choice: { type: 'function', function: { name: 'save_events' } },
            }
          : rung.structured === 'json'
            ? { response_format: { type: 'json_object' } }
            : {}),
      }),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(describeNetworkFailure());
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    let message = '';
    try {
      message = (JSON.parse(detail) as { error?: string }).error || '';
    } catch {
      /* not every error body is JSON */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(message || 'Wrong or missing access code. Enter it in Settings.');
    }
    if (res.status === 429 || res.status === 500) throw new Error(message || `HTTP ${res.status}`);
    // Not every OpenAI-compatible server implements tool calling; fall back once.
    if (attempt + 1 < LADDER.length && (res.status === 400 || res.status === 404 || res.status === 422)) {
      return callModel(content, settings, attempt + 1, options);
    }
    throw new Error(message || `API error ${res.status}: ${detail || res.statusText}`);
  }

  if (!res.body) throw new Error('The endpoint returned no response body.');

  const { text, raw, error } = await readStream(res.body, options.onProgress);
  if (text.trim()) {
    rememberRung(attempt);
    return text;
  }

  // Nothing usable came back. That covers a refusal delivered as an event and
  // a server that accepts a parameter then ignores it — neither shows up in
  // the status — so give up one more assumption and try again.
  if (attempt + 1 < LADDER.length) return callModel(content, settings, attempt + 1, options);

  throw new Error(
    error
      ? `The model provider rejected the request: ${error}`
      : raw.trim()
        ? `The endpoint answered, but with nothing this app could read: ${raw.trim().slice(0, 200)}`
        : 'The endpoint answered with an empty body.',
  );
}

async function runPass(
  source: ExtractionSource,
  settings: Settings,
  withImages: boolean,
  options: ExtractOptions,
): Promise<EventDraft[]> {
  const raw = await callModel(buildUserContent(source, withImages), settings, rememberedRung(), options);
  const parsed = parseJson(raw);
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return events.map(toDraft).filter((e) => e.startDate);
}

/**
 * Read a source, cheapest route first: anything with a usable text layer gets a
 * text-only pass, and the images — which cost far more to send — follow only if
 * that pass finds nothing.
 */
export async function extractEvents(
  source: ExtractionSource,
  settings: Settings,
  options: ExtractOptions = {},
): Promise<EventDraft[]> {
  const hasText = source.text.trim().length >= 40;
  if (hasText) {
    const found = await runPass(source, settings, false, options);
    if (found.length > 0 || source.images.length === 0) return found;
  }

  try {
    return await runPass(source, settings, true, options);
  } catch (err) {
    if ((err as Error).name === 'AbortError' || source.images.length === 0) throw err;
    // Text just worked for other sources, so a failure only on the pass that
    // carries pictures points at the model rather than at this request.
    throw new Error(
      `${(err as Error).message}\n\nThis looks like the model behind the endpoint not accepting images. ` +
        'Pasted text and links still work; photos and scanned PDFs need a vision-capable model.',
    );
  }
}
