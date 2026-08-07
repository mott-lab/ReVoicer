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

// Deterministic, no-network check of whether the LLM can be called at all:
// offline mode off and the selected provider's required credentials present.
// This is the single source of truth — chat() enforces it, the renderer reads
// it via the `desktop:llmStatus` IPC, and api-stub uses it to decide whether a
// new note must be saved as pending. `provider`/`creds`/`model` are the same
// optional overrides chat() accepts (the Review tab passes its own).
// Returns { ok, provider, reason: 'offline' | 'not_configured' | null, message }.
function llmConfigStatus({ provider, creds, model } = {}) {
  const s = getSettingsStore().get();
  if (s.offline_mode) {
    return {
      ok: false,
      provider: null,
      reason: 'offline',
      message: 'Offline mode is on — LLM features are disabled. Turn it off in Settings.',
    };
  }
  provider = provider || s.text_provider || 'openai';
  const cred = (field) => (creds && creds[field] != null && creds[field] !== '' ? creds[field] : s[field]);
  const missing = (label) => ({
    ok: false,
    provider,
    reason: 'not_configured',
    message: `${label} not configured. Open Settings.`,
  });
  if (provider === 'openai') {
    if (!cred('openai_api_key')) return missing('OpenAI API key');
  } else if (provider === 'anthropic') {
    if (!cred('anthropic_api_key')) return missing('Anthropic API key');
  } else if (provider === 'openai_compat') {
    // The API key is optional for OpenAI-compatible endpoints (chat() falls
    // back to a placeholder); base URL and model are what's actually required.
    if (!cred('openai_compat_base_url')) return missing('OpenAI-compatible base URL');
    if (!model && !s.openai_compat_model) return missing('OpenAI-compatible model');
  } else if (provider !== 'ollama') {
    // Ollama needs nothing (base URL defaults to localhost).
    return missing(`Text provider "${provider}"`);
  }
  return { ok: true, provider, reason: null, message: null };
}

function _configError({ reason, message }) {
  const err = new Error(message);
  err.code = reason === 'offline' ? 'OFFLINE' : 'NOT_CONFIGURED';
  err.status = 503;
  return err;
}

// OpenAI reasoning models (GPT-5 family, o1/o3/o4) dropped `max_tokens` in
// favor of `max_completion_tokens` (which also budgets hidden reasoning
// tokens) and only accept the default temperature.
function isOpenAiReasoningModel(model) {
  return /^(gpt-5|o[134])(\b|[-.])/i.test(String(model || ''));
}

// Anthropic sampling parameters (temperature/top_p/top_k) were removed on
// Opus 4.7+, Sonnet 5, and the Fable/Mythos 5 family — sending any value
// returns a 400. Older models still accept them.
function anthropicSamplingRemoved(model) {
  return /claude-(opus-4-[78]|sonnet-5|fable-5|mythos)/i.test(String(model || ''));
}

// Thinking config by model generation, used when streaming reasoning to the
// UI (review generation). Three eras:
// - Claude 4.6+ / 5 family: adaptive thinking; `budget_tokens` is deprecated
//   (4.6) or rejected with a 400 (4.7+, Sonnet 5, Fable 5). On 4.7+ the
//   thinking text defaults to display 'omitted' (empty deltas), so opt back
//   into 'summarized' for the UI feed.
// - Claude 3.7 / earlier 4.x: manual extended thinking with a token budget.
// - Everything else (Haiku, unknown): no thinking config.
function anthropicThinkingConfig(model) {
  const m = String(model || '');
  if (/claude-(opus-4-[78]|sonnet-5|fable-5|mythos)/i.test(m)) {
    return { type: 'adaptive', display: 'summarized' };
  }
  if (/claude-(opus-4-6|sonnet-4-6)/i.test(m)) {
    return { type: 'adaptive' }; // display defaults to 'summarized' on 4.6
  }
  if (/claude-(3-7|opus-4|sonnet-4)/i.test(m)) {
    return { type: 'enabled', budget_tokens: 2048 };
  }
  return null;
}

// `provider`, `model`, `maxTokens`, and `creds` are optional overrides. When
// `provider` is omitted, the configured `text_provider` is used (default
// behavior for cleanup/organize/Q&A). The Review feature passes overrides to
// draft with a different provider/model and a larger token budget. `creds`
// (when present) supplies that provider's credentials — the Review tab keeps
// its own keys/base URLs separate from Text Processing; each field falls back
// to the matching text setting when not provided.
// When `onEvent` is provided, the response is streamed and `onEvent({ type:
// 'thinking' | 'text', delta })` fires for each chunk as it arrives; the
// assembled text is still returned. Thinking deltas only appear when the
// provider/model emits reasoning (Anthropic extended thinking, Ollama reasoning
// models). Without `onEvent`, the original non-streaming path runs unchanged.
async function chat({ system, user, temperature = 0.3, provider, model, maxTokens = 1024, creds, onEvent }) {
  // Offline mode blocks every LLM feature (cleanup, Q&A, organize, review,
  // rubric parse) uniformly — including local Ollama — so offline behavior is
  // predictable. Missing credentials fail here too, before any network call.
  const status = llmConfigStatus({ provider, creds, model });
  if (!status.ok) throw _configError(status);
  const s = getSettingsStore().get();
  provider = status.provider;
  const cred = (field) => (creds && creds[field] != null && creds[field] !== '' ? creds[field] : s[field]);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  if (provider === 'openai' || provider === 'openai_compat') {
    let apiKey, baseURL, useModel;
    if (provider === 'openai') {
      apiKey = cred('openai_api_key');
      baseURL = cred('openai_base_url') || undefined;
      useModel = model || s.openai_model || 'gpt-4o-mini';
    } else {
      baseURL = cred('openai_compat_base_url');
      useModel = model || s.openai_compat_model;
      // Some local endpoints accept any non-empty key (or none). Default to a
      // placeholder so the SDK doesn't error before the request is sent.
      apiKey = cred('openai_compat_api_key') || 'sk-noop';
      // Safety net for the bundled Claude proxy: it's normally started at
      // launch, but this covers a failed startup spawn or a mid-session crash.
      // ensureProxy is single-flight with a health cache, so the steady-state
      // cost here is nil.
      const proxy = require('./proxy-launcher');
      if (proxy.isBundledProxyUrl(baseURL)) {
        const started = await proxy.ensureProxy();
        if (!started.ok) {
          const err = new Error(started.message);
          err.code = 'PROXY_UNAVAILABLE';
          err.status = 503;
          throw err;
        }
      }
    }
    const client = _openaiClient(apiKey, baseURL);
    // Reasoning tokens count against the completion budget, so give the cap
    // headroom (mirrors the Anthropic extended-thinking bump below).
    const reasoningParams = { model: useModel, max_completion_tokens: Math.max(maxTokens, 8192), messages };
    const params = isOpenAiReasoningModel(useModel)
      ? reasoningParams
      : { model: useModel, temperature, max_tokens: maxTokens, messages };

    // Safety net for reasoning models the name check misses (future families,
    // openai_compat proxies): a 400 complaining about max_tokens/temperature
    // gets one retry with the reasoning-style params. The error surfaces from
    // create() before any stream chunk is read, so retrying is safe there too.
    const createWithCompat = async (extra) => {
      try {
        return await client.chat.completions.create({ ...params, ...extra });
      } catch (err) {
        const msg = String(err?.message || '');
        const paramRejected =
          /max_tokens/i.test(msg) && /max_completion_tokens/i.test(msg) ||
          /temperature/i.test(msg) && /unsupported|not supported|does not support/i.test(msg);
        if (params === reasoningParams || !paramRejected) throw err;
        return client.chat.completions.create({ ...reasoningParams, ...extra });
      }
    };

    if (onEvent) {
      const stream = await createWithCompat({ stream: true });
      let text = '';
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta || {};
        // Some OpenAI-compatible reasoning endpoints expose a reasoning stream.
        const r = d.reasoning_content || d.reasoning;
        if (r) onEvent({ type: 'thinking', delta: r });
        if (d.content) { text += d.content; onEvent({ type: 'text', delta: d.content }); }
      }
      return text.trim();
    }
    const resp = await createWithCompat();
    return resp.choices?.[0]?.message?.content?.trim() || '';
  }

  if (provider === 'anthropic') {
    const apiKey = cred('anthropic_api_key');
    const client = _anthropicClientFor(apiKey);
    const amodel = model || s.anthropic_model || 'claude-haiku-4-5-20251001';
    // Only request thinking when streaming to the UI (review) — keeps
    // cleanup/organize/Q&A behavior and cost unchanged.
    const thinking = onEvent ? anthropicThinkingConfig(amodel) : null;
    const params = {
      model: amodel,
      // Thinking output counts against max_tokens (and manual thinking
      // requires max_tokens > budget_tokens), so give the cap headroom.
      max_tokens: thinking ? Math.max(maxTokens, 8192) : maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (thinking) params.thinking = thinking;
    if (!anthropicSamplingRemoved(amodel)) {
      // Manual extended thinking requires the default temperature; adaptive
      // thinking is safest with it omitted. Only plain requests keep the
      // configured value.
      if (!thinking) params.temperature = temperature;
      else if (thinking.type === 'enabled') params.temperature = 1;
    }

    // Safety net mirroring the OpenAI one: if a model outside the name checks
    // rejects a sampling/thinking parameter with a 400, retry once with the
    // bare params (no temperature, no thinking config).
    const strippedParams = {
      model: amodel,
      max_tokens: params.max_tokens,
      system,
      messages: params.messages,
    };
    const hasTunables = 'temperature' in params || 'thinking' in params;
    const paramRejected = (err) =>
      hasTunables &&
      err?.status === 400 &&
      /temperature|top_p|top_k|budget_tokens|thinking/i.test(String(err?.message || ''));

    const runStream = async (p) => {
      const stream = client.messages.stream(p);
      let text = '';
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        const delta = event.delta || {};
        if (delta.type === 'thinking_delta' && delta.thinking) {
          onEvent({ type: 'thinking', delta: delta.thinking });
        } else if (delta.type === 'text_delta' && delta.text) {
          text += delta.text;
          onEvent({ type: 'text', delta: delta.text });
        }
      }
      await stream.finalMessage();
      return text.trim();
    };
    const runCreate = async (p) => {
      const resp = await client.messages.create(p);
      return (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    };

    const run = onEvent ? runStream : runCreate;
    try {
      return await run(params);
    } catch (err) {
      // A param-rejection 400 fires before any content is streamed, so the
      // retry cannot duplicate output already sent to onEvent.
      if (!paramRejected(err)) throw err;
      return run(strippedParams);
    }
  }

  if (provider === 'ollama') {
    const base = (cred('ollama_base_url') || 'http://localhost:11434').replace(/\/$/, '');
    const useModel = model || s.ollama_model || 'llama3.2';

    if (onEvent) {
      // `think: true` asks reasoning models to emit a separate `thinking` field.
      // Older Ollama / non-reasoning models reject it, so retry without on error.
      const post = (think) => fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: useModel, stream: true, think,
          options: { temperature, num_predict: maxTokens }, messages,
        }),
      });
      let resp = await post(true);
      if (!resp.ok) {
        const errText = await resp.text();
        if (/think/i.test(errText)) resp = await post(false);
        else throw new Error(`Ollama error ${resp.status}: ${errText}`);
      }
      if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);

      let text = '', buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          const m = obj.message || {};
          if (m.thinking) onEvent({ type: 'thinking', delta: m.thinking });
          if (m.content) { text += m.content; onEvent({ type: 'text', delta: m.content }); }
        }
      }
      return text.trim();
    }

    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        stream: false,
        options: { temperature, num_predict: maxTokens },
        messages,
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
    // Review tab keeps its own credentials (review_* fields).
    case 'review_openai':
      return testOpenAI({ apiKey: params.review_openai_api_key, baseURL: params.review_openai_base_url || undefined });
    case 'review_openai_compat':
      return testOpenAI({ apiKey: params.review_openai_compat_api_key || 'sk-noop', baseURL: params.review_openai_compat_base_url });
    case 'review_anthropic':
      return testAnthropic({ apiKey: params.review_anthropic_api_key, model: params.review_anthropic_model });
    case 'review_ollama':
      return testOllama({ baseURL: params.review_ollama_base_url });
    default:
      return { ok: false, message: `Unknown provider: ${provider}` };
  }
}

module.exports = { chat, parseJsonResponse, testConnection, llmConfigStatus };
