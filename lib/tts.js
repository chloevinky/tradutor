// OpenAI text-to-speech for pt-BR audio. Plain fetch — no SDK dependency.
const TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

// Returns a Buffer of MP3 bytes for the given Portuguese text.
export async function synthesize({ apiKey, text, voice = 'coral' }) {
  if (!apiKey) {
    const err = new Error('No OpenAI API key configured. Add one in Settings to enable speech.');
    err.code = 'no_openai_key';
    throw err;
  }
  const input = String(text || '').trim().slice(0, 4000);
  if (!input) throw new Error('Nothing to speak.');

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: TTS_VOICES.includes(voice) ? voice : 'coral',
      input,
      instructions: 'Speak in natural Brazilian Portuguese (pt-BR), clearly, at a slightly relaxed pace suitable for a language learner. Use casual Brazilian intonation.',
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* non-JSON body */ }
    const err = new Error(
      res.status === 401 ? 'OpenAI rejected the API key. Check the OpenAI key in Settings.'
      : res.status === 429 ? 'OpenAI rate limit / quota exceeded. ' + detail
      : `OpenAI TTS failed (${res.status}). ${detail}`.trim()
    );
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

// Cheap key sanity check: list models (free, needs valid auth). Only a hard 401
// counts as invalid — network hiccups shouldn't block saving.
export async function validateOpenaiKey(apiKey) {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) throw new Error('OpenAI rejected this API key (401). Double-check it.');
  } catch (err) {
    if (/401/.test(err.message)) throw err;
    // Unreachable API: accept the key; errors will surface on first use.
  }
}
