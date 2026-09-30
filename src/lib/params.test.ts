import { describe, expect, it } from 'vitest';
import { FRESH, refusedParam, sentParams, tuning, withoutRefused, type Quirks } from './params';

// What OpenAI actually answers when a parameter does not suit the model.
const openai = (param: string, message: string) =>
  JSON.stringify({ error: { message, type: 'invalid_request_error', param, code: 'unsupported_parameter' } });

describe('tuning', () => {
  it('sends the current standard to an API it knows nothing about', () => {
    expect(tuning(FRESH, 16000, true)).toEqual({ max_completion_tokens: 16000, temperature: 0, reasoning_effort: 'none' });
  });

  it('leaves out what an API has refused', () => {
    const quirks: Quirks = { tokens: 'max_tokens', temperature: false, reasoning: 'omit' };
    expect(tuning(quirks, 8000, true)).toEqual({ max_tokens: 8000 });
  });

  it('sends no allowance for a picture and no temperature where the rung wants none', () => {
    expect(tuning(FRESH, null, false)).toEqual({ reasoning_effort: 'none' });
  });
});

describe('refusedParam', () => {
  const sent = sentParams({ max_completion_tokens: 16000, temperature: 0, reasoning_effort: 'none', messages: [] });

  it('reads the parameter OpenAI names', () => {
    const body = openai('temperature', "Unsupported value: 'temperature' does not support 0 with this model.");
    expect(refusedParam(400, body, sent)).toBe('temperature');
  });

  it('reads the parameter from the words where no field names it', () => {
    const body = JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } });
    expect(refusedParam(400, body, sent)).toBe('reasoning_effort');
  });

  it('takes the parameter that was sent, not the one suggested instead', () => {
    const body = JSON.stringify({
      error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
    });
    expect(refusedParam(400, body, ['max_tokens', 'temperature'])).toBe('max_tokens');
  });

  it('reads a plain-text refusal', () => {
    expect(refusedParam(422, 'extra fields not permitted: max_completion_tokens', sent)).toBe('max_completion_tokens');
  });

  it('is not fooled by a longer name that contains a sent one', () => {
    expect(refusedParam(400, 'unknown field max_tokens_to_sample', ['max_tokens'])).toBeNull();
  });

  it('says nothing about refusals that are not about a parameter', () => {
    expect(refusedParam(400, openai('tools', 'tools are not supported'), sent)).toBeNull();
    expect(refusedParam(401, openai('', 'Incorrect API key provided: temperature'), sent)).toBeNull();
    expect(refusedParam(400, 'Bad request', sent)).toBeNull();
  });
});

describe('withoutRefused', () => {
  it('steps the allowance from the current name to the old one to none', () => {
    const a = withoutRefused(FRESH, 'max_completion_tokens')!;
    expect(a.tokens).toBe('max_tokens');
    const b = withoutRefused(a, 'max_tokens')!;
    expect(b.tokens).toBe('omit');
    expect(withoutRefused(b, 'max_tokens')).toBeNull();
  });

  it('tries "low" when "none" is refused, then gives up the parameter', () => {
    const a = withoutRefused(FRESH, 'reasoning_effort')!;
    expect(a.reasoning).toBe('low');
    const b = withoutRefused(a, 'reasoning_effort')!;
    expect(b.reasoning).toBe('omit');
    expect(withoutRefused(b, 'reasoning_effort')).toBeNull();
  });

  it('drops the temperature once', () => {
    const a = withoutRefused(FRESH, 'temperature')!;
    expect(a.temperature).toBe(false);
    expect(withoutRefused(a, 'temperature')).toBeNull();
  });
});
