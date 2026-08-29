import { isValidZone, localZone } from './tz';
import type { EventDraft, ExtractionSource, Settings } from './types';

const SYSTEM_PROMPT = `You extract calendar events from event posters, flyers, screenshots, PDFs and web pages.

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

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Called with the best-known title/date while the response is still arriving. */
  onProgress?: (preview: { title: string; date: string }) => void;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function buildUserContent(source: ExtractionSource, withImages: boolean): ContentPart[] {
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
  if (withImages) {
    for (const url of source.images) parts.push({ type: 'image_url', image_url: { url } });
  }
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
async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: ExtractOptions['onProgress'],
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';
  let lastPreview = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let delta: StreamDelta | undefined;
      try {
        delta = (JSON.parse(payload) as { choices?: { delta?: StreamDelta }[] }).choices?.[0]?.delta;
      } catch {
        continue;
      }
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
  return out;
}

async function callModel(
  model: string,
  content: ContentPart[],
  settings: Settings,
  useTools: boolean,
  options: ExtractOptions,
): Promise<string> {
  const key = settings.apiKey.trim();
  const res = await fetch(endpoint(settings.baseUrl), {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      ...(useTools
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
        : { response_format: { type: 'json_object' } }),
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The API rejected the key (HTTP ${res.status}). Check it in Settings. ${detail}`);
    }
    // Not every OpenAI-compatible server implements tool calling; fall back once.
    if (useTools && (res.status === 400 || res.status === 404 || res.status === 422)) {
      return callModel(model, content, settings, false, options);
    }
    throw new Error(`API error ${res.status}: ${detail || res.statusText}`);
  }

  if (!res.body) throw new Error('The API returned an empty response.');
  const text = await readStream(res.body, options.onProgress);
  if (!text.trim()) throw new Error('The API returned an empty response.');
  return text;
}

async function runPass(
  source: ExtractionSource,
  settings: Settings,
  withImages: boolean,
  options: ExtractOptions,
): Promise<EventDraft[]> {
  const model = withImages ? settings.model.trim() : (settings.textModel || settings.model).trim();
  const raw = await callModel(model, buildUserContent(source, withImages), settings, true, options);
  const parsed = parseJson(raw);
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return events.map(toDraft).filter((e) => e.startDate);
}

/**
 * Read a source, cheapest route first: anything with a usable text layer gets a
 * text-only pass, and the images are only sent if that pass finds nothing.
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
  return runPass(source, settings, true, options);
}
