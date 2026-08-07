// PDF Converser - shared error classifier for the renderer.
//
// Maps an error thrown by the in-process API layer (lib/api-client.js, which
// attaches `.status` / `.code` / `.serverMessage` from api-stub responses) to
// user-facing guidance. There is no HTTP backend — failures are either a
// configuration problem the user can fix in Settings, or an internal error.
//
// Returns { kind: 'not_configured' | 'offline' | 'bad_key' | 'proxy' | 'internal',
//           text: string, openSettings: boolean }
// When `openSettings` is true, callers should offer an "Open Settings" action
// wired to window.desktop.openSettings().

// Trims a launcher message down to one clause for embedding mid-sentence.
function detailOf(msg) {
  const trimmed = String(msg || '').split('\n')[0].trim();
  if (!trimmed) return '';
  return `${trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed} `;
}

function describeApiError(err, actionLabel) {
  const msg = String((err && (err.serverMessage || err.message)) || err || '');
  const status = err && err.status;
  const code = err && err.code;

  if (code === 'NOT_CONFIGURED' || /not configured/i.test(msg)) {
    return {
      kind: 'not_configured',
      openSettings: true,
      text: 'No LLM is configured. Open Settings and add an API key for OpenAI, Anthropic, Ollama, or an OpenAI-compatible endpoint.',
    };
  }
  if (code === 'OFFLINE' || /offline mode/i.test(msg)) {
    return {
      kind: 'offline',
      openSettings: true,
      text: 'Offline mode is on — LLM features are disabled. Turn it off in Settings.',
    };
  }
  if (code === 'PROXY_UNAVAILABLE') {
    return {
      kind: 'proxy',
      openSettings: true,
      text: `The bundled Claude Code proxy isn't running. ${detailOf(msg)}Open Settings → OpenAI-compat and click "Set up and test".`,
    };
  }
  if (/Claude CLI exited with code/i.test(msg)) {
    return {
      kind: 'proxy',
      openSettings: true,
      text: 'The proxy is running but the Claude Code CLI failed. Check that `claude` works in a terminal, then re-run "Set up and test" in Settings.',
    };
  }
  if (status === 401 || status === 403 || /invalid.*api key|incorrect api key|authentication/i.test(msg)) {
    return {
      kind: 'bad_key',
      openSettings: true,
      text: 'The provider rejected the configured API key — it may be invalid or expired. Open Settings to check it.',
    };
  }
  const detail = msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
  return {
    kind: 'internal',
    openSettings: false,
    text: detail ? `${actionLabel} failed: ${detail}` : `${actionLabel} failed.`,
  };
}
