// "make a ___" -> part list, through whichever AI the .env has credentials for.
// Env is read on every call, so the server picks up .env even though this module loads first.
import { MODEL_SCHEMA, sanitizeSpec } from '../public/js/spec.js';

export class NoKeyError extends Error {}

const SYSTEM_PROMPT = `You design 3D models for a voice-driven modeling app. The user says what they want; you answer with the object built from simple primitive parts, as JSON matching the schema.

Coordinates
- Units are centimetres. Y is up. The object stands on the ground at y = 0, faces +Z (toward the viewer), and +X is its right.
- Use real-world proportions (a mug is about 10 cm tall, a chair about 90 cm, a car about 450 cm). The app rescales the result to fit, so proportions matter more than absolute size.

Parts
Every part has a shape, dims, points, position (the part's centre, [x, y, z]), rotation ([x, y, z] in degrees, applied in X, Y, Z order about the part's own position) and color (#rrggbb).
- box: dims [width, height, depth], centred on position.
- sphere: dims [radius].
- cylinder: dims [radiusTop, radiusBottom, height]; its axis runs along Y. Rotation [0, 0, 90] lays it along X, [90, 0, 0] along Z.
- cone: dims [radius, height]; the tip points up +Y.
- torus: dims [ringRadius, tubeRadius, arcDegrees]; the ring lies in the XY plane around the Z axis, so it stands upright facing the viewer. A partial arc (e.g. 180) starts at +X and sweeps counter-clockwise toward +Y: good for handles and arches.
- capsule: dims [radius, straightLength]; axis along Y; total height is straightLength + 2 x radius.
- lathe: dims []; points is a profile [[radius, y], ...] listed bottom to top, spun around the part's Y axis. Position is where that axis meets profile y = 0. Use it for vases, bottles, cups, bowls, lamp shades, chess pieces, and wheels (rotated). For hollow vessels trace the outside up, over the rim and back down the inside.
- extrude: dims [thickness]; points is a flat outline [[x, y], ...] (don't repeat the first point) in the XY plane, given thickness along Z and centred on position. Use it for flat or cut-out shapes: chair backs, signs, wings, fins, brackets, letters.
- Use [] for points on every other shape.

Good models
- Build a recognisable object from about 4 to 40 parts. A few well-proportioned parts beat many tiny ones.
- Parts that belong together touch or overlap slightly, so nothing floats by accident.
- Mirror left/right pairs exactly and name them left_... and right_....
- Give parts short unique snake_case names (seat, backrest, left_front_leg) and plausible real colours; parts made of the same material share a colour.
- name is what the object is, in 1 to 4 words.

Changes
When you are given a current model and a change request, return the complete updated model. Keep every part the request doesn't affect exactly as it was (same names and values); change, add or remove only what the request is about.`;

function userMessage(prompt, current) {
  if (!current) return `Make: ${prompt}`;
  return `Current model:\n${JSON.stringify(current)}\n\nChange request: ${prompt}\n\nReturn the complete updated model.`;
}

const env = name => (process.env[name] || '').trim();
const region = () => env('AWS_REGION') || env('AWS_DEFAULT_REGION');
const effort = () => env('CLAUDE_EFFORT') || undefined;   // unset = the API default (high)
const clients = {};

// ---------- OpenAI (Responses API, strict JSON schema) ----------
async function callOpenAI(user, signal) {
  if (!clients.openai) {
    const { default: OpenAI } = await import('openai');
    clients.openai = new OpenAI({ apiKey: env('OPENAI_API_KEY') });
  }
  const reasoningEffort = env('OPENAI_REASONING_EFFORT');
  const res = await clients.openai.responses.create({
    model: PROVIDERS.openai.model(),
    instructions: SYSTEM_PROMPT,
    input: user,
    text: { format: { type: 'json_schema', name: 'model_parts', schema: MODEL_SCHEMA, strict: true } },
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  }, { signal });
  return res.output_text;
}

// ---------- Claude (Anthropic API or Amazon Bedrock) ----------
function claudeParams(model, user) {
  const e = effort();
  return {
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: MODEL_SCHEMA }, ...(e ? { effort: e } : {}) },
  };
}

function claudeText(msg) {
  if (msg.stop_reason === 'refusal') throw new Error(`the model declined (${msg.stop_details?.category ?? 'no reason given'})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('the answer got cut off; try asking for something simpler');
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callAnthropic(user, signal) {
  if (!clients.anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    clients.anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  }
  // fallbacks: "default" re-runs a declined request on Anthropic's recommended fallback model instead of failing
  const msg = await clients.anthropic.beta.messages.create({
    ...claudeParams(PROVIDERS.anthropic.model(), user),
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  }, { signal });
  return claudeText(msg);
}

async function callBedrock(user, signal) {
  if (!clients.bedrock) {
    const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
    clients.bedrock = new AnthropicBedrockMantle({ awsRegion: region() });   // keys come from the AWS_* env vars
  }
  // Bedrock has no server-side fallbacks; a refusal surfaces as an error instead
  const msg = await clients.bedrock.messages.create(claudeParams(PROVIDERS.bedrock.model(), user), { signal });
  return claudeText(msg);
}

// in the order they're tried when AI_PROVIDER isn't set
const PROVIDERS = {
  openai: {
    ready: () => !!env('OPENAI_API_KEY'),
    model: () => env('OPENAI_MODEL') || 'gpt-5.5',
    call: callOpenAI,
  },
  anthropic: {
    ready: () => !!env('ANTHROPIC_API_KEY'),
    model: () => env('ANTHROPIC_MODEL') || 'claude-opus-5',
    call: callAnthropic,
  },
  bedrock: {
    ready: () => !!region() && (!!env('AWS_BEARER_TOKEN_BEDROCK') || (!!env('AWS_ACCESS_KEY_ID') && !!env('AWS_SECRET_ACCESS_KEY'))),
    model: () => env('BEDROCK_MODEL') || 'anthropic.claude-opus-5',
    call: callBedrock,
  },
};

function pickProvider() {
  const forced = env('AI_PROVIDER').toLowerCase();
  if (forced) {
    const p = PROVIDERS[forced];
    if (!p) throw new NoKeyError(`AI_PROVIDER is "${forced}" but must be openai, anthropic or bedrock`);
    return p.ready() ? forced : null;
  }
  return Object.keys(PROVIDERS).find(name => PROVIDERS[name].ready()) || null;
}

export function providerInfo() {
  try {
    const name = pickProvider();
    return name ? { provider: name, model: PROVIDERS[name].model() } : { provider: null };
  } catch { return { provider: null }; }
}

// turns SDK errors into something worth reading out loud, keeping the provider's own words
function explain(err, provider) {
  const said = err?.error?.error?.message || err?.error?.message || '';
  const hint = {
    401: `the ${provider} key was rejected; check it in .env`,
    403: provider === 'bedrock'
      ? 'AWS won\'t let this account use the model yet (Anthropic use-case form, payment method, or an account restriction)'
      : `the ${provider} key isn't allowed to use this model`,
    404: provider === 'bedrock'
      ? `model "${PROVIDERS[provider].model()}" isn't offered in ${region()}; try AWS_REGION=us-east-1`
      : `model "${PROVIDERS[provider].model()}" wasn't found; check the model name in .env`,
    429: `${provider} is rate-limiting us, or the account is out of credit`,
  }[err?.status];
  if (!hint) return err;
  return new Error(said ? `${hint}. ${provider} said: ${said}` : hint);
}

// Asks the AI, validates the answer, and retries once if it came back unusable.
export async function generateModel({ prompt, current = null, signal }) {
  const name = pickProvider();
  if (!name) {
    throw new NoKeyError('No AI key set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY or AWS credentials to .env (see .env.example) and restart the server.');
  }
  const user = userMessage(prompt, current);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try { text = await PROVIDERS[name].call(user, signal); }
    catch (err) { throw explain(err, name); }
    let obj;
    try { obj = JSON.parse(text); }
    catch { lastError = new Error('the AI answer wasn\'t valid JSON'); continue; }
    const { spec, warnings } = sanitizeSpec(obj);
    if (spec) return { spec, warnings, provider: name };
    lastError = new Error(`the AI answer had no usable parts (${warnings.join('; ')})`);
  }
  throw lastError;
}
