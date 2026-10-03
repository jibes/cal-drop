import { describeReach, reachEndpoint } from './reach';
import { fromMessage, messagesStreamPiece, toMessagesBody } from './anthropic';
import { activeEndpoint, apiHeaders, authSecret, chatUrl, wantedModel } from './settings';
import type { Settings } from './types';

/**
 * Find out what an endpoint actually accepts, by asking it one question at a
 * time. Every probe is the minimal request plus exactly one feature, so a
 * refusal names the feature rather than leaving a whole request under
 * suspicion. This exists because "rejected as malformed" is not a diagnosis.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mO4Y2OEFTEMLQkAZyhSgVTvwmkAAAAASUVORK5CYII=';
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

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
  // Room enough for a rehearsal plan. A model asked for more than it will
  // write does not always say so: this endpoint answers with empty chunks,
  // which reads as a broken request until someone tries a smaller number.
  { name: '+ max_tokens: 8000', body: { max_tokens: 8000, messages: [{ role: 'user', content: ASK }] } },
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
  // A picture on its own is not what the app sends: it sends a picture with a
  // system turn and a way of asking for JSON, and a model that takes each of
  // those alone can still answer nothing when they arrive together.
  {
    name: 'image + system role',
    body: {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: DATA_URL } }] },
      ],
    },
  },
  {
    name: 'image + json_object',
    body: {
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${LOOK} As JSON: {"colour":"…"}` }, { type: 'image_url', image_url: { url: DATA_URL } }] },
      ],
    },
  },
  // The exact combination that stopped working: a picture, a tool call, and a
  // cap on the answer. Each of the three passes on its own, which is why this
  // report kept saying everything was fine.
  {
    name: 'image + tools + max_tokens',
    body: {
      max_tokens: 2000,
      tools: [
        {
          type: 'function',
          function: {
            name: 'say_colour',
            description: 'Say the colour.',
            parameters: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'say_colour' } },
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: DATA_URL } }] },
      ],
    },
  },
  {
    name: 'image + tools',
    body: {
      tools: [
        {
          type: 'function',
          function: {
            name: 'say_colour',
            description: 'Say the colour.',
            parameters: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'say_colour' } },
      messages: [
        { role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: DATA_URL } }] },
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
  // A 200 with no answer inside it is the failure this report kept calling
  // "ok": the provider accepted the request, the model said nothing, and only
  // the body shows it. That is exactly the case a photo hits.
  const said = answerIn(trimmed);
  if (!said.trim()) return events.length > 0 ? '200, but the answer was empty' : '200, but no content';
  return events.length > 0 ? `ok (streamed) — said ${JSON.stringify(said.slice(0, 40))}` : `ok — said ${JSON.stringify(said.slice(0, 40))}`;
}

/** Whatever the model actually said, streamed or whole, content or tool call. */
function answerIn(raw: string): string {
  let out = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as {
        type?: string;
        choices?: { delta?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[];
      };
      if (event.type && !event.choices) {
        const piece = messagesStreamPiece(event as Record<string, unknown>);
        out += piece.json ?? piece.text ?? '';
        continue;
      }
      const delta = event.choices?.[0]?.delta;
      out += delta?.content ?? delta?.tool_calls?.[0]?.function?.arguments ?? '';
    } catch {
      /* not an event */
    }
  }
  if (out.trim()) return out;
  const message = fromMessage(raw);
  if (message) return message.text;
  try {
    const message = (JSON.parse(raw) as { choices?: { message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[] })
      .choices?.[0]?.message;
    return (message?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('') || message?.content || '';
  } catch {
    return '';
  }
}


export async function diagnose(settings: Settings, onLine: (line: string) => void): Promise<string> {
  const lines: string[] = [
    `DropToCal API report — ${new Date().toISOString()}`,
    `build    ${__BUILD__} UTC`,
    `api      ${activeEndpoint(settings) || '(none configured)'}`,
    `style    ${settings.apiStyle === 'anthropic' ? "Anthropic's Messages API" : 'OpenAI Chat Completions'}`,
    `model    ${settings.model.trim() || '(none named)'}`,
    `photos   ${settings.visionModel.trim() || '(the same model)'}`,
    `key      ${authSecret(settings) ? 'set' : 'not set'}`,
    '',
  ];
  const emit = (line: string) => {
    lines.push(line);
    onLine(lines.join('\n'));
  };

  if (!activeEndpoint(settings)) {
    emit('No API address is set, so there is nothing to test.');
    return lines.join('\n');
  }

  // Before anything else: is the endpoint there at all, and does it serve this
  // site? Every probe below fails the same unreadable way if it does not, and
  // this is one public GET that needs no key and no preflight.
  {
    let host = activeEndpoint(settings);
    try {
      host = new URL(host).host;
    } catch {
      /* the endpoint's own text will do */
    }
    const found = await reachEndpoint();
    emit(`reach    ${found.reach === 'open' ? 'ok — answers this site' : describeReach(found, host)}`);
    if (found.reach !== 'open') {
      emit('');
      emit('Nothing below can run until that is fixed.');
      return lines.join('\n');
    }
    emit('');
  }

  const auth = apiHeaders(settings);
  const anthropic = settings.apiStyle === 'anthropic';
  let models: string[] = [];
  let imageWorks = false;

  // Which models exist is the question a failed image probe leads to, so
  // answer it in the same report rather than in a second round trip.
  try {
    const res = await fetch(`${activeEndpoint(settings).replace(/\/+$/, '')}/models${anthropic ? '?limit=1000' : ''}`, { headers: auth });
    const body = (await res.json()) as { data?: { id?: string }[] };
    models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    emit(models.length ? `models   ${models.join(', ')}` : `models   (none listed, HTTP ${res.status})`);
  } catch (err) {
    emit(`models   could not be listed: ${(err as Error).message}`);
  }
  emit('');
  // A picture is asked of whichever model takes pictures, exactly as the app
  // would ask it — otherwise the report tests something nobody runs.
  const forText = { model: wantedModel(false, settings) };
  const forImage = { model: wantedModel(true, settings) };
  for (const probe of PROBES) {
    // Spoken to Anthropic, OpenAI's spellings of the same thing are translated
    // into the one Anthropic has — so these would test the translation twice
    // over, and response_format has nothing to become.
    if (anthropic && /as string|input_image|json_object/.test(probe.name)) continue;
    const named = probe.name.startsWith('image:') ? forImage : forText;
    let outcome: string;
    try {
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(anthropic ? toMessagesBody({ ...named, ...probe.body }) : { ...named, ...probe.body }),
      });
      outcome = readOutcome(res.status, await res.text());
    } catch (err) {
      outcome = `could not reach the endpoint: ${(err as Error).message}`;
    }
    if (probe.name.startsWith('image:') && outcome.startsWith('ok')) imageWorks = true;
    emit(`${probe.name.padEnd(32)} ${outcome}`);
  }

  emit('');
  emit('A probe that fails while "minimal" succeeds names the feature to drop.');

  // Knowing that pictures are refused is only half an answer; the other half
  // is which of this provider's models would accept one.
  if (!imageWorks) {
    emit('');
    emit('Images were refused. Name a model that accepts them under "Model for photos".');
    if (models.length) emit(`This API lists: ${models.join(', ')}`);
  }

  return lines.join('\n');
}
