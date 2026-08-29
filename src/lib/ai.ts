import type { EventDraft, ExtractionSource, Settings } from './types';

const SYSTEM_PROMPT = `You extract calendar events from event posters, flyers, screenshots, PDFs and web pages.

Rules:
- Return ONLY events that actually take place, with a concrete date. Ignore printing dates, ticket-sale dates, imprint/copyright years and opening hours of a venue.
- Dates are usually written in the poster's own language and locale. German/European posters use day.month.year; US posters use month/day/year. Use the surrounding language to decide.
- If a poster gives a weekday and a day/month but no year, pick the year that makes the weekday match, preferring the nearest such date that is not in the past relative to the reference date given by the user.
- Times may be written as "20 Uhr", "8pm", "20:00", "Einlass 19:00 / Beginn 20:00". Prefer the START of the event itself (Beginn/Doors-to-start: use the start of the performance if both are given, and mention the doors time in the description).
- If only a date and no time is given, set all_day true.
- A poster may list several events (a festival programme, a series). Return each as its own object.
- Never invent a date. If no date can be read, return an empty list.

Return strict JSON, no markdown fences, in this shape:
{"events":[{"title":string,"start_date":"YYYY-MM-DD","start_time":"HH:MM"|"","end_date":"YYYY-MM-DD"|"","end_time":"HH:MM"|"","all_day":boolean,"location":string,"description":string,"url":string,"confidence":number,"notes":string}]}

"notes" is a short hint for the human reviewer about anything ambiguous (missing year, unclear timezone, two possible readings). "confidence" is 0..1 for how sure you are of the date.`;

interface RawEvent {
  title?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  url?: string;
  confidence?: number;
  notes?: string;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function buildUserContent(source: ExtractionSource): ContentPart[] {
  const today = new Date().toISOString().slice(0, 10);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: `Reference date (today): ${today}. Viewer timezone: ${tz}. Source: ${source.label} (${source.kind}).\n\nExtract every event with its date.`,
    },
  ];
  if (source.text.trim()) {
    parts.push({ type: 'text', text: `--- source text ---\n${source.text.slice(0, 60000)}` });
  }
  for (const url of source.images) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/** Pull a JSON object out of a response that may be wrapped in prose or fences. */
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

function toDraft(raw: RawEvent, i: number): EventDraft {
  const startDate = normalizeDate(raw.start_date);
  const startTime = normalizeTime(raw.start_time);
  return {
    id: `${Date.now()}-${i}`,
    title: (raw.title || 'Untitled event').trim(),
    startDate,
    startTime,
    endDate: normalizeDate(raw.end_date),
    endTime: normalizeTime(raw.end_time),
    allDay: raw.all_day === true || !startTime,
    location: (raw.location || '').trim(),
    description: (raw.description || '').trim(),
    url: (raw.url || '').trim(),
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    notes: (raw.notes || '').trim(),
  };
}

export async function extractEvents(
  source: ExtractionSource,
  settings: Settings,
  signal?: AbortSignal,
): Promise<EventDraft[]> {
  const model =
    source.images.length === 0 && settings.textModel.trim()
      ? settings.textModel.trim()
      : settings.model.trim();

  const res = await fetch(endpoint(settings.baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(source) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body.slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The API rejected the key (HTTP ${res.status}). Check it in Settings. ${detail}`);
    }
    throw new Error(`API error ${res.status}: ${detail || res.statusText}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('The API returned an empty response.');

  const parsed = parseJson(content);
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return events.map(toDraft).filter((e) => e.startDate);
}
