import { extractEvents } from './ai';
import { canFetchNatively, inNativeApp, nativeFetch } from './native';
import { providerFor } from './providers';
import { activeEndpoint, apiHeaders, authSecret, trying, wantedModel } from './settings';
import type { Settings } from './types';

/**
 * "Test connection" for an API of one's own, in the words of someone setting
 * it up: can it be reached, is the key good, do the models exist, and can each
 * of them actually read what the app sends. Every check that reads something
 * goes through the same code a real read takes — so it also teaches the app
 * which parameters this API accepts — and costs a request or two.
 */
export interface CheckLine {
  label: string;
  state: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export type ModelList =
  | { ok: true; ids: string[] }
  | { ok: false; why: 'key' | 'browser' | 'unreachable' | 'http'; detail: string };

/** The models this key may use, as the API lists them. */
export async function listModels(settings: Settings): Promise<ModelList> {
  const base = activeEndpoint(settings);
  let res: Response;
  const native = canFetchNatively();
  // Anthropic lists twenty at a time unless asked for more.
  const list = `${base}/models${settings.apiStyle === 'anthropic' ? '?limit=1000' : ''}`;
  try {
    res = await (native ? nativeFetch : fetch)(list, { headers: apiHeaders(settings) });
  } catch (err) {
    // Asked by the app, no browser rule is involved: it is not there.
    if (native) return { ok: false, why: 'unreachable', detail: (err as Error).message };
    // Refused by the browser or not there at all look the same from here. A
    // request that asks for no reply it may read is not held to the rule, so
    // it tells the two apart.
    try {
      await fetch(`${base}/models`, { mode: 'no-cors' });
      return { ok: false, why: 'browser', detail: '' };
    } catch {
      return { ok: false, why: 'unreachable', detail: '' };
    }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, why: 'key', detail: (await res.text().catch(() => '')).slice(0, 200) };
  }
  if (!res.ok) return { ok: false, why: 'http', detail: `HTTP ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  return { ok: true, ids: ids.sort((a, b) => a.localeCompare(b)) };
}

const SAMPLE_TEXT = 'Test concert: Sunday 3 January 2027 at 19:30 in the Tonhalle, Zürich. Tickets at the door.';
const SAMPLE_DATE = '2027-01-03';

/** A small poster drawn on the spot, since only a picture tests a photo model. */
function samplePoster(): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 600, 400);
  g.fillStyle = '#111';
  g.font = 'bold 48px sans-serif';
  g.fillText('TEST CONCERT', 40, 110);
  g.font = '34px sans-serif';
  g.fillText('Sunday 3 January 2027', 40, 200);
  g.fillText('19:30, Tonhalle Zürich', 40, 260);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** One read of a sample, reported as a line. */
async function read(label: string, images: string[], settings: Settings): Promise<CheckLine> {
  try {
    const events = await extractEvents(
      { kind: images.length ? 'image' : 'text', label: 'test', images, text: images.length ? '' : SAMPLE_TEXT },
      settings,
    );
    const hit = events.find((e) => e.startDate === SAMPLE_DATE);
    if (hit) return { label, state: 'ok', detail: `read "${hit.title}" on ${hit.startDate}${hit.startTime ? ` at ${hit.startTime}` : ''}` };
    return {
      label,
      state: 'warn',
      detail: events.length ? `answered, but read the date as ${events[0].startDate}` : 'answered, but found no event in the sample',
    };
  } catch (err) {
    return { label, state: 'fail', detail: (err as Error).message.split('\n')[0] };
  }
}

export async function checkConnection(settings: Settings, onLine: (lines: CheckLine[]) => void): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const say = (line: CheckLine) => {
    lines.push(line);
    onLine([...lines]);
  };
  const base = activeEndpoint(settings);
  if (!base) {
    say({ label: 'API address', state: 'fail', detail: 'none given' });
    return lines;
  }
  if (!authSecret(settings)) say({ label: 'API key', state: 'warn', detail: 'none given — only an API that needs none will answer' });

  const list = await listModels(settings);
  if (!list.ok) {
    const provider = providerFor(base);
    const detail =
      list.why === 'key'
        ? 'the key was refused'
        : list.why === 'browser'
          ? inNativeApp()
            ? 'the app was refused, though the address answers'
            : `${provider?.name ?? 'This API'} does not let web pages call it. Choose one that does (OpenAI, Anthropic, OpenRouter, Groq, Mistral).`
          : list.why === 'unreachable'
            ? `nothing answered at that address${list.detail ? ` (${list.detail})` : ''}`
            : `the API answered ${list.detail} to a list of models`;
    say({ label: 'Reach the API', state: 'fail', detail });
    // A refused key or a refused browser makes every further check the same failure.
    if (list.why !== 'http') return lines;
  } else {
    say({ label: 'Reach the API', state: 'ok', detail: `key accepted, ${list.ids.length} models offered` });
  }

  const textModel = wantedModel(false, settings);
  const photoModel = wantedModel(true, settings);
  if (!textModel) {
    say({ label: 'Model', state: 'fail', detail: 'none named' });
    return lines;
  }
  if (list.ok && list.ids.length) {
    for (const [label, model] of [['Model', textModel], ['Model for photos', photoModel]] as const) {
      if (label === 'Model for photos' && model === textModel) continue;
      if (!list.ids.includes(model)) say({ label, state: 'warn', detail: `"${model}" is not in the provider's list` });
    }
  }

  await trying(settings, async () => {
    say(await read(`Read text (${textModel})`, [], settings));
    const poster = samplePoster();
    if (poster) say(await read(`Read a photo (${photoModel})`, [poster], settings));
    else say({ label: 'Read a photo', state: 'skip', detail: 'no way to draw a sample here' });
  });
  return lines;
}
