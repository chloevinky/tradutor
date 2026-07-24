// Anthropic API access: streaming Messages calls + defensive JSON parsing.
import Anthropic from '@anthropic-ai/sdk';

let client = null;
let clientKey = null;

export function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

// Streams a response; calls onDelta(text) per chunk; resolves with the full text.
export async function streamCompletion({ apiKey, model, system, userContent, onDelta }) {
  const c = getClient(apiKey);
  const stream = c.messages.stream({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  stream.on('text', (delta) => {
    try {
      onDelta(delta);
    } catch {
      // UI-side delivery failures must not kill the stream.
    }
  });

  const final = await stream.finalMessage();
  let text = '';
  for (const block of final.content) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

// Cheap key validation: models list is free and requires valid auth.
export async function validateKey(apiKey, model) {
  const c = new Anthropic({ apiKey });
  await c.models.retrieve(model);
}

// The prompt demands JSON-only output, but parse defensively anyway:
// strip code fences, slice the outermost object, tolerate trailing junk.
export function parseModelJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Map SDK exceptions to something the UI can show plainly.
export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, code: 'auth', message: 'Invalid API key. Open Settings and paste a valid Anthropic API key.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { status: 403, code: 'permission', message: 'This API key does not have permission for the configured model.' };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { status: 404, code: 'model', message: 'Model not found. Check the model name in Settings.' };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, code: 'rate_limit', message: 'Rate limited by the API. Wait a few seconds and retry.' };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { status: 400, code: 'bad_request', message: `The API rejected the request: ${err.message}` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 0, code: 'network', message: 'Could not reach the Anthropic API. Check your internet connection.' };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status || 500, code: 'api', message: `API error (${err.status}): ${err.message}` };
  }
  return { status: 500, code: 'unknown', message: err?.message || 'Unknown error' };
}
