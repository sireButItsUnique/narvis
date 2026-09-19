// Sentry in the page: errors, performance tracing (linked to the server's traces) and Session Replay, so a
// voice session can be replayed exactly. Loads only when the server has SENTRY_DSN (see /api/config).
const BUNDLE = 'https://browser.sentry-cdn.com/10.75.0/bundle.tracing.replay.min.js';

export async function startSentry(config) {
  if (!config?.sentryDsn || window.Sentry) return false;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = BUNDLE;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Sentry bundle failed to load'));
    document.head.appendChild(s);
  });
  const S = window.Sentry;
  S.init({
    dsn: config.sentryDsn,
    environment: 'hackathon',
    release: 'holomodel@0.1.0',
    integrations: [S.browserTracingIntegration(), S.replayIntegration({ maskAllText: false, blockAllMedia: false })],
    tracesSampleRate: 1.0,
    tracePropagationTargets: [location.origin],   // page -> server traces join up
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
  });
  return true;
}

// tags every event from here on, e.g. which mode the page is in
export function tag(key, value) {
  window.Sentry?.setTag(key, value);
}
