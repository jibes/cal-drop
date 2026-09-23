import { endpoint } from './settings';
import { shrinkFurther } from './image';
import { describeReach, reachEndpoint } from './reach';
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
- source_text must quote, verbatim, the words you read the date and time from. Never paraphrase it, and keep it to the sentence the date was in.
- description is for the event's own particulars — a doors time, a price, who is playing — in at most two sentences. Never copy the page into it: menus, cookie notices, imprints, box-office hours and lists of other events are not part of this event.
- notes is one short sentence, and only when something about the reading itself is uncertain — a year inferred from a weekday, two dates that disagree. Leave it empty when nothing is in doubt. It is never a place for text from the source.
- Never invent a date. If no date can be read, return an empty list.`;

/**
 * Only the tools rung carries the schema in the request; response_format
 * json_object asks for "some JSON" and the plain rung asks for nothing at all.
 * Without the shape spelled out, a model answers in prose or keeps writing
 * until it hits the token cap, which is both unparseable and the most
 * expensive way to fail.
 *
 * Even the tools rung needs it. A tool definition is only a request: a model
 * that cannot call tools — most open-weight vision models, Gemma among them —
 * accepts the parameter, ignores it, and answers in prose, which arrives as a
 * perfectly successful response that will not parse. So the shape is stated in
 * words on every rung, and the schema on the rung that can carry one.
 */
const JSON_SHAPE = `Answer with JSON and nothing else — no prose before or after it, no markdown fence.

The JSON is one object: {"events": [ ... ]}, one entry per event, an empty array if there is none. Each entry has:
- title (string), start_date ("YYYY-MM-DD"), all_day (boolean), source_text (string), confidence (number 0-1) — always present
- start_time, end_date, end_time, location, timezone, rrule, description, url, notes — strings, "" when unknown
- description: the event's own particulars, at most two sentences. notes: one short sentence, only if the reading itself was uncertain.

Stop as soon as the closing brace is written.`;

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
          description: {
            type: 'string',
            description: "the event's own particulars, at most two sentences — never the page's text",
          },
          url: { type: 'string' },
          source_text: { type: 'string', description: 'verbatim quote the date was read from' },
          confidence: { type: 'number' },
          notes: {
            type: 'string',
            description: 'one short sentence about anything uncertain in the reading, or empty',
          },
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

export type ContentPart =
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

/** How each rung reads in a report. */
const RUNG_NAMES = ['with a tool call', 'in JSON mode', 'plainly', 'plainly, no system turn'];

/** Four failures quoting the same 200-character body is not four times as
 *  useful as one, so each line says only enough to tell them apart. */
const short = (message: string) =>
  message.length > 140 ? `${message.slice(0, 140).trimEnd()}…` : message;

const LADDER: Rung[] = [
  { structured: 'tools', system: 'role', temperature: true },
  { structured: 'json', system: 'role', temperature: true },
  { structured: 'none', system: 'role', temperature: true },
  { structured: 'none', system: 'merged', temperature: false },
];

/** What the request carries, which is the thing endpoints disagree about:
 *  a picture is usually answered by a different model from the text. */
type Shape = 'text' | 'image';

const MODE_KEY = 'caldrop.endpointMode.v3';
/** How long a learned rung is trusted. A server's quirks rarely change, but
 *  when they do — a model swapped behind the endpoint, a gateway upgraded —
 *  a remembered rung that never expires keeps paying for a workaround that is
 *  no longer needed. A day's memory costs one extra probe and heals itself. */
const MODE_TTL = 24 * 60 * 60 * 1000;

/**
 * The endpoint's quirks do not change between requests, so pay for finding
 * them once and start there next time. Text and images are remembered apart:
 * behind one endpoint there are usually two models, and what the text model
 * accepts says nothing about what the vision model will.
 */
/** Where to start when nothing has been learned yet. The guess that a vision
 *  model cannot call tools was wrong about this endpoint: the request that
 *  read photos for weeks was a tool call with a picture attached. So both
 *  shapes start at the top, and the ring finds the rest. */
const FIRST_RUNG: Record<Shape, number> = { text: 0, image: 0 };

function rememberedRung(shape: Shape): number {
  try {
    const stored = localStorage.getItem(`${MODE_KEY}.${shape}`);
    if (!stored) return FIRST_RUNG[shape];
    const { rung, at } = JSON.parse(stored) as { rung?: number; at?: number };
    if (!Number.isInteger(rung) || rung! < 0 || rung! >= LADDER.length) return FIRST_RUNG[shape];
    if (!Number.isFinite(at) || Date.now() - at! > MODE_TTL) return FIRST_RUNG[shape];
    return rung!;
  } catch {
    return FIRST_RUNG[shape];
  }
}

function rememberRung(shape: Shape, i: number): void {
  try {
    localStorage.setItem(`${MODE_KEY}.${shape}`, JSON.stringify({ rung: i, at: Date.now() }));
  } catch {
    /* storage disabled; we just re-learn each time */
  }
}

const CAP_KEY = 'caldrop.outputCap.v1';

function rememberedCap(shape: Shape): number {
  try {
    const stored = localStorage.getItem(`${CAP_KEY}.${shape}`);
    if (!stored) return 0;
    const { index, at } = JSON.parse(stored) as { index?: number; at?: number };
    if (!Number.isInteger(index) || index! < 0 || index! >= CAPS.length) return 0;
    if (!Number.isFinite(at) || Date.now() - at! > MODE_TTL) return 0;
    return index!;
  } catch {
    return 0;
  }
}

function rememberCap(shape: Shape, index: number): void {
  try {
    localStorage.setItem(`${CAP_KEY}.${shape}`, JSON.stringify({ index, at: Date.now() }));
  } catch {
    /* storage disabled; we just re-learn each time */
  }
}

/**
 * Every rung, starting with the one that worked last time.
 *
 * The ladder used to be walked downwards only, which made a remembered rung a
 * floor: having learned the bottom one for text, a photo that failed there had
 * nowhere left to go and gave up after a single try — even though the rung
 * above might be exactly what that model wants. Starting at the memory and
 * wrapping keeps the saved probe without ever ruling a rung out.
 */
function rungOrder(shape: Shape): number[] {
  const first = rememberedRung(shape);
  return LADDER.map((_, i) => (first + i) % LADDER.length);
}

/** A rung that did not work. The next one might, so this is not the answer. */
class RungError extends Error {}

/** The answer was cut off in transit. The shape of the request was not the
 *  problem, so the same rung is worth one more try by another route. */
class TransportError extends Error {}

/** An answer with nothing in it, which may be the room asked for rather than
 *  the shape of the asking. */
class EmptyAnswer extends RungError {}

/** The request could not reach the endpoint at all. Nothing about what was
 *  sent is to blame, so it is reported as found rather than second-guessed. */
class ReachError extends Error {}

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Called with the best-known title/date while the response is still arriving. */
  onProgress?: (preview: { title: string; date: string }) => void;
  /** Something worth knowing that did not stop the run. */
  onNote?: (note: string) => void;
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
async function describeNetworkFailure(signal?: AbortSignal): Promise<string> {
  if (!endpoint) return NO_ENDPOINT;
  let host = endpoint;
  try {
    host = new URL(chatUrl()).host;
  } catch {
    /* an unconfigured endpoint is its own answer */
  }
  // Three possibilities used to be listed here for the reader to choose from.
  // One public GET, asked twice, decides between them.
  return [
    `The request never left the browser.`,
    describeReach(await reachEndpoint(signal), host),
  ].join('\n');
}

/**
 * Content is a plain string unless there are images to attach. The array form
 * is valid everywhere in theory, but a number of servers only accept it when
 * it actually carries an image, and reject a text-only array as malformed.
 */
function buildUserContent(source: ExtractionSource, withImages: boolean): string | ContentPart[] {
  const today = new Date().toISOString().slice(0, 10);
  const preamble = `Reference date (today): ${today}. Viewer timezone: ${localZone() || 'unknown'}. Source: ${source.label} (${source.kind}).\n\nExtract every event with its date.`;
  const body = source.text.trim() ? `${preamble}\n\n--- source text ---\n${source.text.slice(0, 60000)}` : preamble;

  if (!withImages || source.images.length === 0) return body;

  // One text part, then the pictures. Splitting the words across several parts
  // is valid and widely accepted, but some providers answer a multi-part
  // message with nothing at all, and an empty 200 is indistinguishable from a
  // model that had nothing to say. The single part is the shape every server
  // that takes images at all is known to take.
  const parts: ContentPart[] = [{ type: 'text', text: body }];
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

/**
 * The events an unfinished answer did manage to write.
 *
 * A list cut off mid-object is not broken JSON in the useful sense: every
 * object before the cut is complete and every one of them is an event someone
 * wants. Rather than throw away twenty dates because the twenty-first is half
 * written, the array is walked by brace depth and the whole objects are kept.
 */
function salvageEvents(content: string): RawEvent[] {
  const start = content.indexOf('[', content.indexOf('"events"'));
  if (start === -1) return [];

  const found: RawEvent[] = [];
  let depth = 0;
  let from = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) from = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && from !== -1) {
        try {
          found.push(JSON.parse(content.slice(from, i + 1)) as RawEvent);
        } catch {
          /* a complete brace pair that is not an object: not an event either */
        }
        from = -1;
      }
    }
  }
  return found;
}

function parseJson(content: string): { events?: RawEvent[] } {
  const cleaned = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(
        `The model answered in prose rather than JSON: "${cleaned.slice(0, 160).replace(/\s+/g, ' ')}"`,
      );
    }
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

/**
 * A field is as long as the model felt like making it, and one came back with
 * an entire web page in it — flagged as a caveat, drawn as a wall of text, and
 * carried into the calendar. Asking in the prompt is worth doing and is not a
 * limit; these are.
 */
const LIMITS = { title: 200, location: 300, description: 1500, sourceText: 300, notes: 200 } as const;

const clip = (value: string | undefined, max: number): string => {
  const text = (value || '').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
};

function toDraft(raw: RawEvent, i: number): EventDraft {
  const startTime = normalizeTime(raw.start_time);
  const timezone = (raw.timezone || '').trim();
  return {
    id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    title: clip(raw.title, LIMITS.title) || 'Untitled event',
    startDate: normalizeDate(raw.start_date),
    startTime,
    endDate: normalizeDate(raw.end_date),
    endTime: normalizeTime(raw.end_time),
    allDay: raw.all_day === true || !startTime,
    location: clip(raw.location, LIMITS.location),
    timezone: isValidZone(timezone) ? timezone : '',
    rrule: normalizeRrule(raw.rrule),
    description: clip(raw.description, LIMITS.description),
    url: (raw.url || '').trim(),
    sourceText: clip(raw.source_text, LIMITS.sourceText),
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    notes: clip(raw.notes, LIMITS.notes),
  };
}

/** The same fact from a whole, non-streamed body. */
function wasCutShort(raw: string): boolean {
  try {
    return (
      (JSON.parse(raw) as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason ===
      'length'
    );
  } catch {
    return false;
  }
}

interface StreamDelta {
  content?: string;
  tool_calls?: { function?: { arguments?: string } }[];
}

/**
 * A 200 with no answer in it. The body is the evidence, but 200 characters of
 * JSON is not a sentence — so where the shape is recognisable, say what it
 * means: the model was asked, it replied, and it put nothing in the reply.
 */
function describeSilence(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    const choice = body.choices?.[0];
    if (choice && !choice.message?.content?.trim()) {
      const who = body.model ? ` (${body.model})` : '';
      const why = choice.finish_reason && choice.finish_reason !== 'stop' ? `, stopping at ${choice.finish_reason}` : '';
      return `The model answered with nothing at all${who}${why}.`;
    }
  } catch {
    /* not a completion body; the raw text is all there is */
  }
  return `The endpoint answered, but with nothing this app could read: ${raw.trim().slice(0, 200)}`;
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
    // A model may split its answer across several tool calls, and may send an
    // empty string in one channel while the answer is in the other — so both
    // are read, and an empty string counts as nothing rather than as an answer.
    const called = (message?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('');
    return called.trim() ? called : (message?.content ?? '');
  } catch {
    return '';
  }
}

/** Nothing at all for this long means the answer is not coming. Long enough
 *  that a slow model thinking before its first token is not cut off, short
 *  enough that a spinner does not become the whole experience. */
const SILENCE_MS = 60000;

async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: ExtractOptions['onProgress'],
): Promise<{ text: string; raw: string; error: string; broken: boolean; truncated: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let out = '';
  let error = '';
  let lastPreview = '';

  let broken = false;
  let truncated = false;

  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      // A read that never resolves is the one failure with no error to catch:
      // the connection is open, the server is silent, and the app waits for
      // ever. Waiting is given a limit so that it becomes a failure like any
      // other — and one the whole-answer retry can then try to get past.
      step = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error('silence')), SILENCE_MS),
        ),
      ]);
    } catch (err) {
      // The connection died mid-answer. Chrome words this "network error",
      // which reads like the request never left — it did, and what arrived
      // before the break may even be a whole answer.
      if ((err as Error).name === 'AbortError') throw err;
      broken = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
    if (step.done) break;
    const { value } = step;
    const chunk = decoder.decode(value!, { stream: true });
    raw += chunk;
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let event:
        | {
            choices?: { delta?: StreamDelta; finish_reason?: string }[];
            error?: { message?: string };
          }
        | undefined;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      // A refusal can arrive as an event on a 200 response, so the status code
      // never sees it; without this it reads as an answer containing nothing.
      if (event?.error?.message) error = event.error.message;
      // "length" means the model was still writing when it ran out of room.
      if (event?.choices?.[0]?.finish_reason === 'length') truncated = true;
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
  return {
    text: out.trim() ? out : fromCompletion(raw),
    raw,
    error,
    broken,
    truncated: truncated || wasCutShort(raw),
  };
}

/**
 * Room for roughly twenty events, which is a dense festival programme, and a
 * ceiling on a model that starts explaining itself rather than answering —
 * unconstrained, one of them returned 2787 tokens for a single event, all of
 * it paid for and none of it wanted.
 */

/**
 * Exactly what the app asks the endpoint, exported so that measuring the cost
 * of a run measures a real one. A request built separately for the report
 * would drift, and did: without the structured-output constraint the model
 * answered at length and the measurement was of something the app never sends.
 */
/**
 * How long an answer may run, biggest first.
 *
 * A cap is not a preference, it is a limit the model has: ask for more room
 * than it will give and this provider does not clamp the number, it answers
 * with empty chunks and says nothing at all — which is indistinguishable from
 * a broken request and was, for one evening, reported as one. So the caps are
 * walked like the rungs: the first that produces an answer is remembered, and
 * a day later it is tried from the top again in case the model behind the
 * endpoint has changed.
 */
const CAPS = [8000, 4000, 2000];

/**
 * How long an answer may run when a cap is safe to send.
 *
 * 2000 was a poster's worth, and a poster is not the hard case: a rehearsal
 * plan or a festival programme is a table of twenty or thirty dates, and each
 * one costs a hundred tokens or so to write down. Cut off mid-list, the JSON
 * does not parse, every rung is tried against the same wall, and the reader
 * is told their endpoint is broken. This is room for around sixty events,
 * which is a long programme — still a ceiling, just not one that a normal
 * document walks into.
 */
const MAX_OUTPUT_TOKENS = CAPS[0];

const carriesImage = (content: string | ContentPart[]) =>
  Array.isArray(content) && content.some((part) => part.type === 'image_url');

export function requestBody(
  content: string | ContentPart[],
  attempt = rememberedRung('text'),
  stream = true,
  cap = MAX_OUTPUT_TOKENS,
) {
  const rung = LADDER[attempt] ?? LADDER[LADDER.length - 1];
  return {
    // No model: the endpoint decides which one answers.
    //
    // A cap, except on a picture. It was the only parameter the request gained
    // between photos working and photos coming back empty, from a provider
    // saying "likely an unsupported request parameter that the provider
    // silently dropped" — but text has always been answered with it, and
    // without any cap an answer that does not stop has nothing to stop it.
    stream,
    ...(carriesImage(content) ? {} : { max_tokens: cap }),
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
  };
}

function messagesFor(rung: Rung, content: string | ContentPart[]) {
  const instructions = `${SYSTEM_PROMPT}\n\n${JSON_SHAPE}`;
  if (rung.system === 'role') {
    return [
      { role: 'system', content: instructions },
      { role: 'user', content },
    ];
  }
  // No system turn: the instructions lead the user message instead. With a
  // picture attached they lead its text part rather than becoming a second
  // one — the message keeps the single-text-part shape that every server
  // taking images is known to accept.
  if (typeof content === 'string') {
    return [{ role: 'user', content: `${instructions}\n\n---\n\n${content}` }];
  }
  const first = content.findIndex((part) => part.type === 'text');
  const merged: ContentPart[] =
    first === -1
      ? [{ type: 'text', text: instructions }, ...content]
      : content.map((part, i) =>
          i === first && part.type === 'text'
            ? { type: 'text', text: `${instructions}\n\n---\n\n${part.text}` }
            : part,
        );
  return [{ role: 'user', content: merged }];
}

async function callModel(
  content: string | ContentPart[],
  settings: Settings,
  attempt: number,
  options: ExtractOptions,
  stream = true,
  cap = MAX_OUTPUT_TOKENS,
): Promise<{ text: string; broken: boolean; truncated: boolean }> {
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
      body: JSON.stringify(requestBody(content, attempt, stream, cap)),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // A request that never left is usually the endpoint being unreachable —
    // unless it was carrying a photo to an endpoint that does serve this
    // page, in which case the upload itself died and a smaller one may still
    // get through. Anything else (the origin refused, nothing listening, no
    // network) no smaller photo will fix, so it is named rather than retried.
    if (Array.isArray(content) && (await reachEndpoint(options.signal)) === 'open') {
      throw new TransportError('The photo could not be sent — the upload did not complete.');
    }
    throw new ReachError(await describeNetworkFailure(options.signal));
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
    // Not every server takes tools, a response_format or a system turn, and
    // the ones that do not say so here. Another rung may suit them better.
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw new RungError(message || `The endpoint rejected that request (HTTP ${res.status}).`);
    }
    throw new Error(message || `API error ${res.status}: ${detail || res.statusText}`);
  }

  if (!res.body) throw new Error('The endpoint returned no response body.');

  const { text, raw, error, broken, truncated } = await readStream(res.body, options.onProgress);
  // A broken stream can still leave a whole answer behind, and often leaves
  // half of one — which only the parse can tell apart, so it travels with it.
  if (text.trim()) return { text, broken, truncated };

  // Cut off with nothing to show for it. A long-lived response carrying a
  // photo is the one most likely to be dropped between the provider, the
  // endpoint and a phone, and none of that is the request's fault.
  if (broken) {
    throw new TransportError(
      stream
        ? 'The connection dropped while the answer was arriving.'
        : 'The connection dropped before the answer arrived.',
    );
  }

  // Nothing usable came back. That covers a refusal delivered as an event and
  // a server that accepts a parameter then ignores it — neither shows up in
  // the status — so give up one more assumption and try again.
  if (error) throw new RungError(`The model provider rejected the request: ${error}`);
  // Chunks arrived and every one of them was empty. That can be the shape of
  // the request — or the room asked for, which is why it has its own name.
  throw new EmptyAnswer(raw.trim() ? describeSilence(raw) : 'The endpoint answered with an empty body.');
}

async function runPass(
  source: ExtractionSource,
  settings: Settings,
  withImages: boolean,
  options: ExtractOptions,
): Promise<EventDraft[]> {
  const shape: Shape = withImages && source.images.length > 0 ? 'image' : 'text';
  const content = buildUserContent(source, withImages);
  let last: Error | undefined;
  /** What each way of asking did, so a failure names them rather than being
   *  four identical attempts reported as one sentence. */
  const tally: string[] = [];

  // Every rung gets its turn. A rung fails by being refused, by answering with
  // nothing, or — the only way a model that ignores tools can fail — by
  // answering in prose that will not parse; none of those is the endpoint's
  // final word while a rung remains untried.
  let cap = rememberedCap(shape);

  for (const attempt of rungOrder(shape)) {
    /** One rung, by both routes: streamed, then — if the line broke rather
     *  than the request being wrong — whole, which needs the connection to
     *  survive only the delivery instead of the whole generation. */
    const tryRung = async (): Promise<EventDraft[]> => {
      let broken = false;
      for (const stream of [true, false]) {
        let answer: { text: string; broken: boolean; truncated: boolean } | undefined;
        let failure: unknown;

        /**
         * Nothing at all came back. Before deciding the request was shaped
         * wrong, ask for less room: a model given a cap beyond what it will
         * write answers with empty chunks rather than with a complaint, and
         * that looks exactly like a rung that does not work. The caps are
         * descended here rather than left to the next rung to stumble into.
         */
        for (;;) {
          try {
            answer = await callModel(content, settings, attempt, options, stream, CAPS[cap]);
            break;
          } catch (err) {
            if (err instanceof EmptyAnswer && cap + 1 < CAPS.length && !carriesImage(content)) {
              cap += 1;
              continue;
            }
            failure = err;
            break;
          }
        }

        if (!answer) {
          const err = failure;
          if (err instanceof TransportError) {
            broken = true;
            last = err;
            continue;
          }
          // Keep what the endpoint said: if no rung works, it is the answer.
          if (err instanceof RungError) {
            last = err;
            tally.push(`${RUNG_NAMES[attempt]}: ${short(err.message)}`);
          }
          throw err;
        }
        try {
          const parsed = parseJson(answer.text);
          rememberRung(shape, attempt);
          rememberCap(shape, cap);
          const events = Array.isArray(parsed.events) ? parsed.events : [];
          return events.map(toDraft).filter((e) => e.startDate);
        } catch (err) {
          /**
           * An answer that ran out of room is not a rung that does not work:
           * the shape was right and there was simply more to say than there
           * was room to say it. Walking the ladder would ask four times and
           * hit the same wall four times, so what was written is kept instead.
           */
          if (answer.truncated) {
            const salvaged = salvageEvents(answer.text)
              .map(toDraft)
              .filter((e) => e.startDate);
            if (salvaged.length > 0) {
              rememberRung(shape, attempt);
              rememberCap(shape, cap);
              options.onNote?.(
                `That is a long list, and the endpoint stopped the answer before the end of it. ` +
                  `These ${salvaged.length} came through; anything after them did not.`,
              );
              return salvaged;
            }
            throw new Error(
              'The answer was cut off before a single whole event came through. ' +
                'The source is longer than this endpoint will answer in one go — try a part of it.',
            );
          }
          last = err as Error;
          // Half an answer is not the rung's fault; a whole one that will not
          // parse is, and asking again the same way would only repeat it.
          if (!answer.broken) {
            tally.push(`${RUNG_NAMES[attempt]}: ${short(last.message)}`);
            throw new RungError(last.message);
          }
          broken = true;
        }
      }
      // Said in the words of what went wrong, not of the half-answer it left.
      // An upload that never completed keeps its own words: no answer was
      // ever on its way.
      if (broken) {
        if (!(last instanceof TransportError)) {
          last = new TransportError('The connection dropped while the answer was arriving.');
        }
        throw last;
      }
      throw new RungError(last?.message ?? 'That way of asking got nothing back.');
    };

    try {
      return await tryRung();
    } catch (err) {
      // A different shape is worth trying; a connection that dropped twice is
      // not, and a photo is too big to keep uploading on the off chance.
      if (err instanceof RungError) continue;
      throw err;
    }
  }

  // Every rung refused. What each one said is the diagnosis, so all of it goes
  // out: one line per way of asking, rather than the last one standing in for
  // four attempts nobody can see.
  throw new Error(
    tally.length > 1
      ? `No way of asking worked:\n${tally.map((line) => `• ${line}`).join('\n')}`
      : (last?.message ?? 'The endpoint gave no usable answer.'),
  );
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
    // The line could not carry the picture. Carry less of it: a poster's
    // headline and date read perfectly well at 900px, and it is a quarter of
    // the bytes — which is the difference on a connection that just failed.
    if (err instanceof TransportError && source.images.length > 0) {
      try {
        const smaller = await Promise.all(source.images.map(shrinkFurther));
        return await runPass({ ...source, images: smaller }, settings, true, options);
      } catch (retry) {
        if ((retry as Error).name === 'AbortError') throw retry;
        throw new Error(
          `${(retry as Error).message}\n\nThe photo was sent again at a smaller size and did not get ` +
            'through either. The endpoint is up and serves this app, so it is the connection that ' +
            'cannot carry a photo right now — try again on a better one, or paste the text instead.',
        );
      }
    }
    if ((err as Error).name === 'AbortError' || err instanceof ReachError) throw err;
    if (source.images.length === 0) throw err;
    // Text just worked for other sources, so a failure only on the pass that
    // carries pictures points at the model rather than at this request. Which
    // model, though, depends on how it failed: a refusal means the images were
    // not accepted, while an answer in prose means they were read by a model
    // that cannot be made to answer in JSON.
    const message = (err as Error).message;
    if (message.includes('connection dropped') || message.includes('upload did not complete')) {
      throw new Error(
        `${message}\n\nA photo is the largest thing this app sends, so it is the one a shaky ` +
          'connection loses. Try again, or use the text if you have it.',
      );
    }
    throw new Error(
      message.includes('in prose')
        ? `${message}\n\nThe model reading the photo answered in words instead of data. ` +
            'Pasted text and links still work; a photo needs a vision model that can follow a JSON format.'
        : `${message}\n\nAll four ways of asking were tried and the picture got nothing back from any ` +
            'of them, so this is the model behind the endpoint rather than the request. Pasted text and ' +
            'links still work; photos and scanned PDFs need a vision-capable model.',
    );
  }
}
