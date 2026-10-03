/**
 * Anthropic's Messages API, spoken through the same requests as everything else.
 *
 * The app builds every request in the OpenAI Chat Completions shape — the
 * ladder, the caps, the probes in the report — and an API that speaks
 * Anthropic's dialect gets that request translated on its way out and its
 * answer translated on the way back. The ideas are the same on both sides;
 * the spelling is not:
 *
 *   OpenAI                                   Anthropic
 *   POST /chat/completions                   POST /messages
 *   Authorization: Bearer <key>              x-api-key: <key>, anthropic-version
 *   a message with role "system"             a top-level `system`
 *   {type: image_url, image_url: {url}}      {type: image, source: {base64 | url}}
 *   tools[].function.parameters              tools[].input_schema
 *   tool_choice {function: {name}}           tool_choice {type: tool, name}
 *   max_tokens optional                      max_tokens required
 *   response_format json_object              no such thing — the prompt asks for JSON
 *   stream: delta.content / tool_calls       content_block_delta: text / input_json
 *   finish_reason "length"                   stop_reason "max_tokens"
 */

/** The version of the Messages API this was written against. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** What a request may say when it says nothing about length; the API insists. */
const DEFAULT_MAX_TOKENS = 8000;

type Json = Record<string, unknown>;

interface OpenAiPart {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  source?: unknown;
}

/** A picture as Anthropic takes one: the bytes, or an address it fetches itself. */
function imageBlock(url: string): Json {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return inline
    ? { type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2] } }
    : { type: 'image', source: { type: 'url', url } };
}

function contentFor(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return (content as OpenAiPart[]).map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
    if (part.type === 'image_url' || part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url ?? '');
      return imageBlock(url);
    }
    // Already in Anthropic's own shape (the report probes one), or unknown:
    // passed on as it is, for the API to accept or name.
    return part;
  });
}

/** An OpenAI-shaped request, as the Messages API wants it. */
export function toMessagesBody(body: Json): Json {
  const messages = (body.messages as { role: string; content: unknown }[]) ?? [];
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const cap = Number(body.max_tokens ?? body.max_completion_tokens) || DEFAULT_MAX_TOKENS;

  const out: Json = {
    model: body.model,
    max_tokens: cap,
    ...(system ? { system } : {}),
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentFor(m.content) })),
  };
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.temperature !== undefined) out.temperature = body.temperature;

  const tools = body.tools as { function?: { name?: string; description?: string; parameters?: unknown } }[] | undefined;
  if (tools?.length) {
    out.tools = tools.map((t) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    }));
    const chosen = (body.tool_choice as { function?: { name?: string } } | undefined)?.function?.name;
    if (chosen) out.tool_choice = { type: 'tool', name: chosen };
  }
  // response_format and reasoning_effort have no counterpart and are left out:
  // the prompt already asks for JSON alone, and thinking is off unless asked for.
  return out;
}

/** What one streamed event adds to the answer. */
export interface StreamPiece {
  text?: string;
  json?: string;
  truncated?: boolean;
  error?: string;
}

/** One `data:` line of a Messages stream, read. Events it has no use for add nothing. */
export function messagesStreamPiece(event: Json): StreamPiece {
  const delta = event.delta as { type?: string; text?: string; partial_json?: string; stop_reason?: string } | undefined;
  switch (event.type) {
    case 'content_block_delta':
      if (delta?.type === 'text_delta') return { text: delta.text ?? '' };
      if (delta?.type === 'input_json_delta') return { json: delta.partial_json ?? '' };
      return {};
    case 'message_delta':
      return delta?.stop_reason === 'max_tokens' ? { truncated: true } : {};
    case 'error':
      return { error: (event.error as { message?: string } | undefined)?.message ?? 'The API reported an error.' };
    default:
      return {};
  }
}

/** A whole, non-streamed Messages answer: the tool's input if it called one, else its words. */
export function fromMessage(raw: string): { text: string; truncated: boolean } | null {
  try {
    const body = JSON.parse(raw) as { type?: string; content?: Json[]; stop_reason?: string };
    if (!Array.isArray(body.content)) return null;
    const called = body.content.filter((b) => b.type === 'tool_use').map((b) => JSON.stringify(b.input ?? {}));
    const said = body.content
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('');
    return { text: called.length ? called.join('') : said, truncated: body.stop_reason === 'max_tokens' };
  } catch {
    return null;
  }
}
