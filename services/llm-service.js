// Provider-agnostic LLM wrapper. Routes by `text_provider`:
//   openai          → openai SDK (api.openai.com or custom openai_base_url)
//   anthropic       → @anthropic-ai/sdk
//   ollama          → POST /api/chat on the configured base URL
//   openai_compat   → openai SDK with custom baseURL (Groq, OpenRouter,
//                     LM Studio, vLLM, llama.cpp server, etc.)

const { getSettingsStore } = require('./settings-store');

let _openaiClients = new Map(); // cacheKey → instance
let _anthropicClient = null;
let _anthropicKey = null;

function _openaiClient(apiKey, baseURL) {
  const key = `${apiKey}::${baseURL || ''}`;
  if (_openaiClients.has(key)) return _openaiClients.get(key);
  const OpenAI = require('openai');
  const ClientCtor = OpenAI.default || OpenAI;
  const opts = { apiKey };
  if (baseURL) opts.baseURL = baseURL;
  const client = new ClientCtor(opts);
  _openaiClients.set(key, client);
  return client;
}

function _anthropicClientFor(apiKey) {
  if (_anthropicClient && _anthropicKey === apiKey) return _anthropicClient;
  const Anthropic = require('@anthropic-ai/sdk');
  const ClientCtor = Anthropic.default || Anthropic;
  _anthropicClient = new ClientCtor({ apiKey });
  _anthropicKey = apiKey;
  return _anthropicClient;
}

function _missing(field) {
  const err = new Error(`${field} not configured. Open Settings.`);
  err.code = 'NOT_CONFIGURED';
  err.status = 503;
  return err;
}

async function chat({ system, user, temperature = 0.3 }) {
  const s = getSettingsStore().get();
  const provider = s.text_provider || 'openai';

  if (provider === 'openai') {
    if (!s.openai_api_key) throw _missing('OpenAI API key');
    const client = _openaiClient(s.openai_api_key, s.openai_base_url || undefined);
    const resp = await client.chat.completions.create({
      model: s.openai_model || 'gpt-4o-mini',
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || '';
  }

  if (provider === 'openai_compat') {
    if (!s.openai_compat_base_url) throw _missing('OpenAI-compatible base URL');
    if (!s.openai_compat_model) throw _missing('OpenAI-compatible model');
    // Some local endpoints accept any non-empty key (or none). Default to a
    // placeholder so the SDK doesn't error before the request is sent.
    const client = _openaiClient(s.openai_compat_api_key || 'sk-noop', s.openai_compat_base_url);
    const resp = await client.chat.completions.create({
      model: s.openai_compat_model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || '';
  }

  if (provider === 'anthropic') {
    if (!s.anthropic_api_key) throw _missing('Anthropic API key');
    const client = _anthropicClientFor(s.anthropic_api_key);
    const resp = await client.messages.create({
      model: s.anthropic_model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    });
    // Response content is an array of blocks; concat text blocks.
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text;
  }

  if (provider === 'ollama') {
    const base = (s.ollama_base_url || 'http://localhost:11434').replace(/\/$/, '');
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: s.ollama_model || 'llama3.2',
        stream: false,
        options: { temperature },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return (data?.message?.content || '').trim();
  }

  throw new Error(`Unknown text_provider: ${provider}`);
}

function parseJsonResponse(content) {
  try { return JSON.parse(content); }
  catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return null;
  }
}

// ─── Test connection helpers. Each returns {ok, message, latencyMs, models?}.

async function testOpenAI({ apiKey, baseURL }) {
  if (!apiKey) return { ok: false, message: 'API key is empty' };
  const t0 = Date.now();
  try {
    const client = _openaiClient(apiKey, baseURL || undefined);
    const list = await client.models.list();
    const models = (list.data || []).map((m) => m.id).sort();
    return { ok: true, message: `${models.length} models available`, latencyMs: Date.now() - t0, models };
  } catch (err) {
    return { ok: false, message: err.message || String(err), latencyMs: Date.now() - t0 };
  }
}

async function testAnthropic({ apiKey, model }) {
  if (!apiKey) return { ok: false, message: 'API key is empty' };
  const t0 = Date.now();
  try {
    const client = _anthropicClientFor(apiKey);
    // Prefer listing models (also verifies auth) so the Settings UI can surface
    // them. Fall back to a minimal 1-token request for SDKs/keys without
    // models.list access.
    if (client.models && typeof client.models.list === 'function') {
      try {
        const list = await client.models.list();
        const models = (list.data || []).map((m) => m.id).sort();
        if (models.length) {
          return { ok: true, message: `${models.length} models available`, latencyMs: Date.now() - t0, models };
        }
      } catch { /* fall through to the auth check */ }
    }
    // Minimal 1-token request — cheaper than a models list and verifies auth.
    await client.messages.create({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { ok: true, message: 'Authenticated', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, message: err.message || String(err), latencyMs: Date.now() - t0 };
  }
}

async function testOllama({ baseURL }) {
  const base = (baseURL || 'http://localhost:11434').replace(/\/$/, '');
  const t0 = Date.now();
  try {
    const resp = await fetch(`${base}/api/tags`);
    if (!resp.ok) {
      return { ok: false, message: `HTTP ${resp.status}`, latencyMs: Date.now() - t0 };
    }
    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name).sort();
    return {
      ok: true,
      message: models.length ? `${models.length} models pulled` : 'Connected (no models pulled)',
      latencyMs: Date.now() - t0,
      models,
    };
  } catch (err) {
    return { ok: false, message: err.message || String(err), latencyMs: Date.now() - t0 };
  }
}

// Dispatcher used by the Settings UI.
async function testConnection(provider, params) {
  switch (provider) {
    case 'openai':
      return testOpenAI({ apiKey: params.openai_api_key, baseURL: params.openai_base_url || undefined });
    case 'openai_compat':
      return testOpenAI({ apiKey: params.openai_compat_api_key || 'sk-noop', baseURL: params.openai_compat_base_url });
    case 'anthropic':
      return testAnthropic({ apiKey: params.anthropic_api_key, model: params.anthropic_model });
    case 'ollama':
      return testOllama({ baseURL: params.ollama_base_url });
    default:
      return { ok: false, message: `Unknown provider: ${provider}` };
  }
}

module.exports = { chat, parseJsonResponse, testConnection };
