/**
 * The tuning parameters of an OpenAI-compatible request, and what to do when
 * an API refuses one.
 *
 * The standard has moved under the app's feet. OpenAI's reasoning models —
 * the o-series and GPT-5 — refuse `max_tokens` and ask for
 * `max_completion_tokens`, refuse any temperature but the default, and take
 * `reasoning_effort`, which older models and other servers refuse in turn.
 * Nothing says in advance which kind of model is on the other end, and a
 * refusal names the parameter it objects to, so the answer is to send the
 * current standard, and when one is refused, ask again without it — the same
 * request otherwise, not a different way of asking. What worked is kept per
 * API and model, so the next request starts from there.
 */

export type Param = 'max_completion_tokens' | 'max_tokens' | 'temperature' | 'reasoning_effort';

export interface Quirks {
  /** Which name the output allowance goes by, if any is accepted. */
  tokens: 'max_completion_tokens' | 'max_tokens' | 'omit';
  /** Whether temperature 0 is accepted. */
  temperature: boolean;
  /**
   * How little to think before answering. "none" is fastest and not every
   * provider has it; "low" is the least every reasoning model accepts; a model
   * that does not reason at all refuses the parameter outright.
   */
  reasoning: 'none' | 'low' | 'omit';
}

/** Where every API starts until it has refused something. */
export const FRESH: Quirks = { tokens: 'max_completion_tokens', temperature: true, reasoning: 'none' };

/**
 * The tuning part of a request body.
 *
 * `cap` is omitted for a picture — see the note on the request in ai.ts —
 * and `temperature` only goes where the way of asking wants it at all.
 */
export function tuning(quirks: Quirks, cap: number | null, wantsTemperature: boolean): Record<string, unknown> {
  return {
    ...(cap !== null && quirks.tokens !== 'omit' ? { [quirks.tokens]: cap } : {}),
    ...(wantsTemperature && quirks.temperature ? { temperature: 0 } : {}),
    ...(quirks.reasoning !== 'omit' ? { reasoning_effort: quirks.reasoning } : {}),
  };
}

/** The parameters a body actually carries, which are the only ones it can be refused for. */
export function sentParams(body: Record<string, unknown>): Param[] {
  return (['max_completion_tokens', 'max_tokens', 'temperature', 'reasoning_effort'] as Param[]).filter(
    (p) => body[p] !== undefined,
  );
}

/**
 * Which of the parameters sent a refusal is about, or null when it is about
 * something else.
 *
 * OpenAI names it in `error.param`. Other servers only say it in the message
 * ("Unrecognized request argument supplied: reasoning_effort"), so the
 * message is read too — for the sent parameter it mentions first, since
 * OpenAI's own wording names a second one it would prefer: "'max_tokens' is
 * not supported with this model. Use 'max_completion_tokens' instead."
 */
export function refusedParam(status: number, body: string, sent: Param[]): Param | null {
  if (status !== 400 && status !== 422) return null;
  let param = '';
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { param?: unknown; message?: unknown } | string; message?: unknown };
    const error = parsed.error;
    if (error && typeof error === 'object') {
      if (typeof error.param === 'string') param = error.param;
      if (typeof error.message === 'string') message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (typeof parsed.message === 'string') {
      message = parsed.message;
    }
  } catch {
    /* not JSON: the words are all there is */
  }
  if ((sent as string[]).includes(param)) return param as Param;
  const lower = message.toLowerCase();
  let first: Param | null = null;
  let at = Infinity;
  for (const p of sent) {
    // Whole names only, so "max_tokens" is not found inside "max_tokens_to_sample".
    const match = new RegExp(`(^|[^a-z_])${p}([^a-z_]|$)`).exec(lower);
    if (match && match.index < at) {
      at = match.index;
      first = p;
    }
  }
  return first;
}

/**
 * The next thing to try once a parameter is refused, or null when there is
 * nothing left to take away — then it is the way of asking that does not
 * work, and the ladder in ai.ts takes over.
 */
export function withoutRefused(quirks: Quirks, param: Param): Quirks | null {
  switch (param) {
    case 'max_completion_tokens':
      return quirks.tokens === 'max_completion_tokens' ? { ...quirks, tokens: 'max_tokens' } : null;
    case 'max_tokens':
      return quirks.tokens === 'max_tokens' ? { ...quirks, tokens: 'omit' } : null;
    case 'temperature':
      return quirks.temperature ? { ...quirks, temperature: false } : null;
    case 'reasoning_effort':
      if (quirks.reasoning === 'none') return { ...quirks, reasoning: 'low' };
      if (quirks.reasoning === 'low') return { ...quirks, reasoning: 'omit' };
      return null;
  }
}

// ---- remembered per API and model ----

const KEY = 'caldrop.quirks.v1';
/** A week: a model's parameters change with a new model, not between requests. */
const TTL = 7 * 24 * 60 * 60 * 1000;

const valid = (q: Partial<Quirks> | undefined): q is Quirks =>
  !!q &&
  ['max_completion_tokens', 'max_tokens', 'omit'].includes(q.tokens as string) &&
  typeof q.temperature === 'boolean' &&
  ['none', 'low', 'omit'].includes(q.reasoning as string);

export function rememberedQuirks(api: string, model: string): Quirks {
  try {
    const stored = JSON.parse(localStorage.getItem(`${KEY}.${api}|${model}`) || 'null') as
      | { quirks?: Partial<Quirks>; at?: number }
      | null;
    if (stored && valid(stored.quirks) && Number.isFinite(stored.at) && Date.now() - stored.at! < TTL) {
      return stored.quirks;
    }
  } catch {
    /* storage disabled or garbled: start fresh */
  }
  return { ...FRESH };
}

export function rememberQuirks(api: string, model: string, quirks: Quirks): void {
  try {
    localStorage.setItem(`${KEY}.${api}|${model}`, JSON.stringify({ quirks, at: Date.now() }));
  } catch {
    /* storage disabled; it is learned again next time */
  }
}
