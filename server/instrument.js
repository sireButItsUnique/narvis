// Sentry for the server. Loaded before the app (node --import ./server/instrument.js server.js) so its automatic
// instrumentation can hook in. Does nothing until SENTRY_DSN is in .env.
//   Tracing: every request, every Fable build (gen_ai.invoke_agent), model turn (gen_ai.chat), tool call
//            (gen_ai.execute_tool) and Blender bridge call (blender.bridge), so you can see where a build's time goes.
//   AI agent monitoring: the gen_ai spans above, plus Anthropic/OpenAI calls the SDK instruments on its own.
//   Logs: Sentry.logger calls plus console warnings and errors.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const dsn = (process.env.SENTRY_DSN || '').trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'hackathon',
    release: 'holomodel@0.1.0',
    tracesSampleRate: 1.0,   // every build is interesting at a hackathon
    enableLogs: true,
    sendDefaultPii: false,
    integrations: [
      Sentry.anthropicAIIntegration({ recordInputs: true, recordOutputs: true }),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
  });
  console.log('Sentry: on (tracing, AI agent monitoring, logs)');
}
