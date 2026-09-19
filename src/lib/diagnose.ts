import { endpoint } from './settings';
import type { Settings } from './types';

/**
 * Find out what an endpoint actually accepts, by asking it one question at a
 * time. Every probe is the minimal request plus exactly one feature, so a
 * refusal names the feature rather than leaving a whole request under
 * suspicion. This exists because "rejected as malformed" is not a diagnosis.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mO4Y2OEFTEMLQkAZyhSgVTvwmkAAAAASUVORK5CYII=';
const DATA_URL = `data:image/png;base64,${PNG_B64}`;
const HOSTED = endpoint.replace(/\/+$/, '') + '/test-image';

const ASK = 'Reply with the single word OK.';
const LOOK = 'What colour is this image? One word.';

interface Probe {
  name: string;
  body: Record<string, unknown>;
}

const PROBES: Probe[] = [
  { name: 'minimal (user message only)', body: { messages: [{ role: 'user', content: ASK }] } },
  { name: '+ stream: true', body: { stream: true, messages: [{ role: 'user', content: ASK }] } },
  { name: '+ temperature: 0', body: { temperature: 0, messages: [{ role: 'user', content: ASK }] } },
  { name: '+ max_tokens: 64', body: { max_tokens: 64, messages: [{ role: 'user', content: ASK }] } },
  {
    name: '+ system role',
    body: { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: ASK }] },
  },
  {
    name: '+ content as array of parts',
    body: { messages: [{ role: 'user', content: [{ type: 'text', text: ASK }] }] },
  },
  // Providers disagree on how an image is attached, so each shape is asked
  // separately — a 400 for one of them is not a verdict on images as such.
  {
    name: 'image: image_url {url: data:}',
    body: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: DATA_URL } }] },
      ],
    },
  },
  {
    name: 'image: image_url {url: https:}',
    body: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: HOSTED } }] },
      ],
    },
  },
  {
    name: 'image: image_url as string',
    body: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: DATA_URL }] },
      ],
    },
  },
  {
    name: 'image: input_image',
    body: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'input_image', image_url: DATA_URL }] },
      ],
    },
  },
  {
    name: 'image: base64 source block',
    body: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: LOOK },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          ],
        },
      ],
    },
  },
  {
    name: '+ response_format: json_object',
    body: {
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: `${ASK} As JSON: {"ok":true}` }],
    },
  },
  {
    name: '+ tools / tool_choice',
    body: {
      tools: [
        {
          type: 'function',
          function: {
            name: 'say_ok',
            description: 'Say OK.',
            parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'say_ok' } },
      messages: [{ role: 'user', content: ASK }],
    },
  },
];

const chatUrl = () =>
  endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;

/** Anything an endpoint says about a failure, from wherever it chose to say it. */
function readOutcome(status: number, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return status === 200 ? 'empty body' : `HTTP ${status}, empty body`;

  // An error can arrive as JSON, or as an event on an otherwise fine stream.
  const events = trimmed.split('\n').filter((l) => l.startsWith('data:'));
  for (const line of events) {
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as { error?: { message?: string } };
      if (parsed.error?.message) return `REJECTED: ${parsed.error.message}`;
    } catch {
      /* [DONE] and keep-alives are not JSON */
    }
  }
  if (status !== 200) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: string } | string;
        upstream?: { status?: number; detail?: string };
      };
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      // The endpoint wraps what the provider said; the provider's own words are
      // the diagnosis, so prefer them over the wrapper's summary.
      const detail = parsed.upstream?.detail;
      if (detail) return `HTTP ${status}: ${detail.slice(0, 200)}`;
      if (message) return `HTTP ${status}: ${message}`;
    } catch {
      /* not JSON */
    }
    return `HTTP ${status}: ${trimmed.slice(0, 120)}`;
  }
  return events.length > 0 ? 'ok (streamed)' : 'ok';
}

export async function diagnose(settings: Settings, onLine: (line: string) => void): Promise<string> {
  const lines: string[] = [
    `CalDrop endpoint report — ${new Date().toISOString()}`,
    `build    ${__BUILD__} UTC`,
    `endpoint ${endpoint || '(none configured)'}`,
    `code     ${settings.accessCode.trim() ? 'set' : 'not set'}`,
    '',
  ];
  const emit = (line: string) => {
    lines.push(line);
    onLine(lines.join('\n'));
  };

  if (!endpoint) {
    emit('No endpoint is configured in this build, so there is nothing to test.');
    return lines.join('\n');
  }

  const code = settings.accessCode.trim();
  const auth: Record<string, string> = code ? { Authorization: `Bearer ${code}` } : {};

  // Which models exist is the question a failed image probe leads to, so
  // answer it in the same report rather than in a second round trip.
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, { headers: auth });
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
    emit(ids.length ? `models   ${ids.join(', ')}` : `models   (none listed, HTTP ${res.status})`);
  } catch (err) {
    emit(`models   could not be listed: ${(err as Error).message}`);
  }
  emit('');
  for (const probe of PROBES) {
    let outcome: string;
    try {
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(probe.body),
      });
      outcome = readOutcome(res.status, await res.text());
    } catch (err) {
      outcome = `could not reach the endpoint: ${(err as Error).message}`;
    }
    emit(`${probe.name.padEnd(32)} ${outcome}`);
  }

  emit('');
  emit('A probe that fails while "minimal" succeeds names the feature to drop.');
  return lines.join('\n');
}
