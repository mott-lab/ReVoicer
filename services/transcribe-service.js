// Speech-to-text transcription. Routes by `speech_provider`:
//   openai_whisper → OpenAI Whisper API (uses openai_api_key)
//   browser        → no-op; the renderer's Web Speech API live transcript
//                    is already in `raw_transcript`, so we return empty text
//                    and content.js falls back to it.
//   off            → no-op; same shape (the mic FAB is hidden via CSS so
//                    this path normally isn't reached).

const { getSettingsStore } = require('./settings-store');

async function transcribeAudio({ data, type, name }) {
  const settings = getSettingsStore().get();
  const provider = settings.speech_provider || 'openai_whisper';

  // Offline mode: never hit the cloud. The renderer normally intercepts
  // transcribe requests itself (preload.js), so this is a safety net; the
  // empty text makes content.js fall back to the live (Vosk) transcript.
  if (settings.offline_mode) {
    return { text: '', skipped: 'offline' };
  }

  // 'local_whisper' is handled in the renderer (see preload.js's
  // tryLocalWhisper); if it ever reaches here it's a misroute, fall through
  // to a safe empty response. 'off' and the legacy 'browser' value resolve
  // to the same safe-empty path so content.js's fallback uses whatever live
  // transcript it already has (which will normally be empty).
  if (provider === 'local_whisper' || provider === 'browser' || provider === 'off') {
    return { text: '', skipped: provider };
  }

  if (provider !== 'openai_whisper') {
    const err = new Error(`Unknown speech_provider: ${provider}`);
    err.status = 503;
    throw err;
  }

  if (!settings.openai_api_key) {
    const err = new Error('OpenAI API key not configured. Open Settings to set it.');
    err.code = 'NO_API_KEY';
    err.status = 503;
    throw err;
  }

  const OpenAI = require('openai');
  const { toFile } = require('openai/uploads');
  const ClientCtor = OpenAI.default || OpenAI;
  const client = new ClientCtor({ apiKey: settings.openai_api_key });

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const filename = name || `recording.${(type || 'audio/webm').includes('webm') ? 'webm' : 'mp4'}`;
  const file = await toFile(buffer, filename, type ? { type } : undefined);

  try {
    const transcript = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      response_format: 'text',
    });
    const text = typeof transcript === 'string' ? transcript : (transcript?.text || '');
    return { text: text.trim() };
  } catch (err) {
    const wrapped = new Error(`Whisper API error: ${err.message || err}`);
    wrapped.status = 502;
    throw wrapped;
  }
}

module.exports = { transcribeAudio };
