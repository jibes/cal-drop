/**
 * Check whether an OpenAI-compatible endpoint can actually drive CalDrop.
 *
 *   CALDROP_BASE_URL=https://api.example.ai/v1 \
 *   CALDROP_API_KEY=sk-... \
 *   CALDROP_MODEL=some-model \
 *   npm run probe
 *
 * CalDrop needs four things, and endpoints differ on every one of them:
 * streaming, tool calling (with a json_object fallback), image input, and a
 * model that reads dates correctly. This probes all four, the last one by
 * running the app's own extraction path — not a reimplementation of it.
 */
import { build } from 'esbuild';

const BASE = (process.env.CALDROP_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const KEY = process.env.CALDROP_API_KEY || '';
const MODEL = process.env.CALDROP_MODEL || 'gpt-4o-mini';
const URL_ = BASE.endsWith('/chat/completions') ? BASE : `${BASE}/chat/completions`;

if (!KEY) {
  console.error('Set CALDROP_API_KEY (and optionally CALDROP_BASE_URL / CALDROP_MODEL).');
  process.exit(2);
}

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33mWARN\x1b[0m ${m}`);

const results = {};

async function post(body) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  return res;
}

async function collectStream(res) {
  let text = '';
  let sawChunks = 0;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta;
        const piece = delta?.tool_calls?.[0]?.function?.arguments ?? delta?.content ?? '';
        if (piece) sawChunks++;
        text += piece;
      } catch {
        /* keep-alive or comment line */
      }
    }
  }
  return { text, sawChunks };
}

console.log(`\nEndpoint : ${URL_}\nModel    : ${MODEL}\n`);

// 1 — does it answer at all
console.log('1. Basic chat completion');
try {
  const res = await post({ messages: [{ role: 'user', content: 'Reply with the word OK.' }] });
  if (!res.ok) {
    fail(`HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  pass(`answered: ${JSON.stringify(reply?.slice(0, 60))}`);
  results.basic = true;
} catch (e) {
  fail(e.message);
  process.exit(1);
}

// 2 — streaming, which the live preview depends on
console.log('\n2. Streaming (stream: true)');
try {
  const res = await post({
    stream: true,
    messages: [{ role: 'user', content: 'Count from 1 to 20, separated by commas.' }],
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { text, sawChunks } = await collectStream(res);
  if (sawChunks === 0) throw new Error('no SSE deltas arrived — the response was not a stream');
  pass(`${sawChunks} delta${sawChunks === 1 ? '' : 's'}, ${text.length} chars`);
  if (sawChunks === 1) warn('arrived as a single delta, so the live preview will just pop in at the end');
  results.stream = true;
} catch (e) {
  fail(`${e.message} — CalDrop needs streaming; it has no non-streaming path`);
  results.stream = false;
}

// 3 — tool calling, the structured-output path
console.log('\n3. Tool calling (structured output)');
const tool = {
  type: 'function',
  function: {
    name: 'save_events',
    description: 'Save every event found in the source.',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, start_date: { type: 'string' } },
            required: ['title', 'start_date'],
          },
        },
      },
      required: ['events'],
    },
  },
};
try {
  const res = await post({
    stream: true,
    tools: [tool],
    tool_choice: { type: 'function', function: { name: 'save_events' } },
    messages: [{ role: 'user', content: 'Konzert am 12.09.2026. Save it.' }],
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { text } = await collectStream(res);
  JSON.parse(text);
  pass(`returned parseable arguments: ${text.slice(0, 120)}`);
  results.tools = true;
} catch (e) {
  warn(`${e.message}`);
  warn('CalDrop will fall back to response_format: json_object — checked next');
  results.tools = false;
}

// 4 — the json_object fallback
console.log('\n4. response_format: json_object (fallback)');
try {
  const res = await post({
    stream: true,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: 'Return JSON: {"events":[{"title":"x","start_date":"2026-09-12"}]}' }],
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { text } = await collectStream(res);
  JSON.parse(text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim());
  pass('returned parseable JSON');
  results.json = true;
} catch (e) {
  fail(e.message);
  results.json = false;
}

// 5 — image input, which posters and photos require
console.log('\n5. Image input (image_url parts)');
// A 1x1 PNG is enough to prove the content part is accepted rather than rejected.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
try {
  const res = await post({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this image? One word.' },
          { type: 'image_url', image_url: { url: PIXEL } },
        ],
      },
    ],
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  pass(`accepted an image: ${JSON.stringify(data.choices?.[0]?.message?.content?.slice(0, 60))}`);
  results.vision = true;
} catch (e) {
  fail(e.message);
  warn('Without image input, photos, screenshots and scanned PDFs cannot be read.');
  warn('Set VITE_AI_MODEL to a vision model and keep this one as VITE_AI_TEXT_MODEL.');
  results.vision = false;
}

// 6 — the real thing: CalDrop's own extraction, bundled straight from src
console.log("\n6. CalDrop's own extraction path (real prompt, real parsing)");
const bundled = await build({
  entryPoints: ['src/lib/ai.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  logLevel: 'error',
});
const { extractEvents } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const POSTER = `SOMMERFEST IM HOF
Sa 12.09. — Einlass 19:00, Beginn 20 Uhr
Kulturzentrum Alte Feuerwache, Berlin
Eintritt frei

Jeden Dienstag: Jam Session, 21 Uhr, Bar Zwei`;

try {
  const events = await extractEvents(
    { kind: 'text', label: 'probe poster', images: [], text: POSTER },
    { baseUrl: BASE, apiKey: KEY, model: MODEL, textModel: '', corsProxy: '' },
    { onProgress: ({ title }) => title && process.stdout.write(`\r  …streaming: ${title.slice(0, 50)}`) },
  );
  process.stdout.write(`\r${' '.repeat(72)}\r`);
  if (events.length === 0) {
    fail('parsed the response but found no dated events');
    results.extract = false;
  } else {
    for (const e of events) {
      console.log(
        `  • ${e.title} — ${e.startDate}${e.startTime ? ` ${e.startTime}` : ' (all day)'}` +
          `${e.rrule ? ` [${e.rrule}]` : ''}${e.timezone ? ` ${e.timezone}` : ''}`,
      );
      console.log(`    quote: "${e.sourceText}"  confidence ${e.confidence}`);
    }
    const main = events.find((e) => /sommerfest/i.test(e.title));
    const weekly = events.find((e) => e.rrule);
    if (main?.startDate?.endsWith('-09-12') && main?.startTime === '20:00') {
      pass('read the European date and the "Beginn" time correctly');
    } else {
      warn('found events, but the headline date/time is not 2026-09-12 20:00 — check the locale handling');
    }
    if (weekly) pass(`picked up the recurrence: ${weekly.rrule}`);
    else warn('missed the weekly Jam Session recurrence');
    results.extract = true;
  }
} catch (e) {
  fail(e.message);
  results.extract = false;
}

console.log('\n--- verdict ---');
const usable = results.basic && results.stream && (results.tools || results.json) && results.extract;
console.log(usable ? 'Usable with CalDrop.' : 'Not usable as-is — see the failures above.');
console.log(
  results.vision
    ? 'Handles photos and scanned PDFs too.'
    : 'Text only: pair it as VITE_AI_TEXT_MODEL with a vision model in VITE_AI_MODEL.',
);
process.exit(usable ? 0 : 1);
