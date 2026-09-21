import { requestBody, type ContentPart } from './ai';
import { describeReach, reachEndpoint } from './reach';
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
      const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[] })
        .choices?.[0]?.delta;
      out += delta?.content ?? delta?.tool_calls?.[0]?.function?.arguments ?? '';
    } catch {
      /* not an event */
    }
  }
  if (out.trim()) return out;
  try {
    const message = (JSON.parse(raw) as { choices?: { message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[] })
      .choices?.[0]?.message;
    return (message?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('') || message?.content || '';
  } catch {
    return '';
  }
}

/**
 * The models worth asking, by the names providers give vision models — minus
 * the ones whose names look similar for unrelated reasons: an image generator,
 * a speech model and an embedding model all fail this test for no useful
 * reason, and each wasted attempt costs a request against the quota.
 */
function visionCandidates(models: string[]): string[] {
  const looksVision = /(^|[-.])vl([-.]|$)|vision|pixtral|gemma-[34]/i;
  const notAReader = /embed|whisper|flux|guard|bge-|e5-|image$|-image|paraphrase/i;
  return models.filter((id) => looksVision.test(id) && !notAReader.test(id)).slice(0, 6);
}

/** A poster-sized picture, because an image's token cost scales with its size
 *  and a tiny test pixel would measure nothing the app ever sends. */
function posterSizedImage(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1600;
  const ctx = canvas.getContext('2d');
  if (!ctx) return DATA_URL;
  ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 1200, 1600);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 90px sans-serif';
  ctx.fillText('SOMMERFEST', 80, 400);
  ctx.font = '54px sans-serif';
  ctx.fillText('Sa 12.09. — 20 Uhr', 80, 520);
  return canvas.toDataURL('image/jpeg', 0.85);
}

const SAMPLE_POSTER = `SOMMERFEST IM HOF
Sa 12.09. — Einlass 19:00, Beginn 20 Uhr
Kulturzentrum Alte Feuerwache, Berlin
Eintritt frei

Jeden Dienstag: Jam Session, 21 Uhr, Bar Zwei`;

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Token counts, from wherever the answer put them. A server may stream even
 * when not asked to, in which case the usage rides on one of the events rather
 * than sitting in a JSON body.
 */
function readUsage(raw: string): Usage | undefined {
  try {
    const whole = JSON.parse(raw) as { usage?: Usage };
    if (whole.usage) return whole.usage;
  } catch {
    /* not a single JSON body; try it as a stream */
  }
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.trim().slice(5).trim()) as { usage?: Usage };
      if (event.usage?.prompt_tokens) return event.usage;
    } catch {
      /* [DONE] and keep-alives are not JSON */
    }
  }
  return undefined;
}

const money = (euros: number) =>
  euros >= 0.01 ? `€${euros.toFixed(3)}` : `${(euros * 100).toFixed(4)} cents`;

/** Without grouping, because a thousand separator reads as a decimal point to
 *  half the world and the figure beside it is a decimal. */
const plainCount = (n: number) => n.toLocaleString('en-US', { useGrouping: false });

/**
 * What a run actually costs, measured rather than estimated: one real
 * extraction of each kind, with the token counts the provider reports and the
 * prices the endpoint is configured with. Estimating image tokens in
 * particular is guesswork — pan-and-scan means one photo can be several crops.
 */
async function measureCost(emit: (line: string) => void, auth: Record<string, string>): Promise<void> {
  const base = endpoint.replace(/\/+$/, '');

  let prices: {
    model?: string;
    visionModel?: string;
    perMillionTokens?: { in: number; out: number; visionIn: number; visionOut: number };
  } = {};
  try {
    prices = await (await fetch(`${base}/pricing`, { headers: auth })).json();
  } catch {
    /* an endpoint without pricing still reports tokens */
  }
  const rates = prices.perMillionTokens;

  emit('');
  emit('Cost of one run, measured:');

  const runs: { label: string; model?: string; vision: boolean; content: unknown }[] = [
    {
      label: 'pasted poster text',
      model: prices.model,
      vision: false,
      content: SAMPLE_POSTER,
    },
    {
      label: 'photo of a poster',
      model: prices.visionModel,
      vision: true,
      content: [
        { type: 'text', text: 'Read the events in this image.' },
        { type: 'image_url', image_url: { url: posterSizedImage() } },
      ],
    },
  ];

  for (const run of runs) {
    try {
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        // The app's own request, with delivery the one difference: token
        // counts ride on the response body, and a provider that streams need
        // not report them at all. Same prompt, same constraints, same cost.
        body: JSON.stringify({
          ...requestBody(run.content as string | ContentPart[]),
          stream: false,
        }),
      });
      const raw = await res.text();
      if (!res.ok) {
        emit(`  ${run.label.padEnd(20)} ${readOutcome(res.status, raw)}`);
        continue;
      }
      const usage = readUsage(raw);
      if (!usage?.prompt_tokens) {
        emit(`  ${run.label.padEnd(20)} answered, but reported no token usage`);
        continue;
      }
      const inTok = usage.prompt_tokens ?? 0;
      const outTok = usage.completion_tokens ?? 0;
      let line = `  ${run.label.padEnd(20)} ${inTok} in + ${outTok} out tokens`;
      if (rates) {
        const perIn = run.vision ? rates.visionIn : rates.in;
        const perOut = run.vision ? rates.visionOut : rates.out;
        const cost = (inTok * perIn + outTok * perOut) / 1_000_000;
        line += `  =  ${money(cost)}  (${plainCount(Math.round(1 / cost))} runs per €1)`;
      }
      emit(line);
      if (run.model) emit(`  ${''.padEnd(20)} on ${run.model}`);
    } catch (err) {
      emit(`  ${run.label.padEnd(20)} ${(err as Error).message}`);
    }
  }

  if (!rates) emit('  (set PRICE_IN / PRICE_OUT in wrangler.toml to see money as well as tokens)');
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

  // Before anything else: is the endpoint there at all, and does it serve this
  // site? Every probe below fails the same unreadable way if it does not, and
  // this is one public GET that needs no access code and no preflight.
  {
    let host = endpoint;
    try {
      host = new URL(endpoint).host;
    } catch {
      /* the endpoint's own text will do */
    }
    const reach = await reachEndpoint();
    emit(`reach    ${reach === 'open' ? 'ok — answers this site' : describeReach(reach, host)}`);
    if (reach !== 'open') {
      emit('');
      emit('Nothing below can run until that is fixed.');
      return lines.join('\n');
    }
    emit('');
  }

  const code = settings.accessCode.trim();
  const auth: Record<string, string> = code ? { Authorization: `Bearer ${code}` } : {};
  let models: string[] = [];
  let imageWorks = false;

  // Which models exist is the question a failed image probe leads to, so
  // answer it in the same report rather than in a second round trip.
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, { headers: auth });
    const body = (await res.json()) as { data?: { id?: string }[] };
    models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    emit(models.length ? `models   ${models.join(', ')}` : `models   (none listed, HTTP ${res.status})`);
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
    if (probe.name.startsWith('image:') && outcome.startsWith('ok')) imageWorks = true;
    emit(`${probe.name.padEnd(32)} ${outcome}`);
  }

  emit('');
  emit('A probe that fails while "minimal" succeeds names the feature to drop.');

  await measureCost(emit, auth);

  // Knowing that pictures are refused is only half an answer; the other half
  // is which of this provider's models would accept one.
  if (!imageWorks) {
    emit('');
    emit('Images were refused, so trying the models most likely to accept one:');
    for (const model of visionCandidates(models)) {
      let outcome: string;
      try {
        const res = await fetch(`${endpoint.replace(/\/+$/, '')}/probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: LOOK },
                  { type: 'image_url', image_url: { url: DATA_URL } },
                ],
              },
            ],
          }),
        });
        outcome = readOutcome(res.status, await res.text());
      } catch (err) {
        outcome = `could not reach the endpoint: ${(err as Error).message}`;
      }
      emit(`  ${model.padEnd(30)} ${outcome}`);
      if (outcome.startsWith('ok')) {
        emit('');
        emit(`Use this: VISION_MODEL = "${model}" in worker/wrangler.toml.`);
        return lines.join('\n');
      }
    }
    emit('');
    emit('None of those accepted an image. Photos need a different provider.');
  }

  return lines.join('\n');
}
