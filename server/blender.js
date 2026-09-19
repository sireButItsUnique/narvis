// Voice -> Blender. Claude Fable 5.1 writes Blender Python, runs it in the server's hidden Blender through the
// bridge, looks at renders of the result, and fixes what's off, until the model is done.
import * as Sentry from '@sentry/node';   // spans and logs are no-ops until SENTRY_DSN is set
import { blender, callBlender } from './blender-process.js';
import { TEXTURE_TOOL, textureToolAvailable, runTextureTool } from './texture-tool.js';

const env = name => (process.env[name] || '').trim();
export const blenderModel = () => env('BLENDER_MODEL') || 'claude-fable-5-1';
const effort = () => env('BLENDER_EFFORT') || 'high';
const MAX_TURNS = 16;
const research = () => env('BLENDER_RESEARCH').toLowerCase() !== 'off';
const WEB_SEARCH_USD = 0.01;   // $10 per 1,000 searches
// $ per million tokens [input, output, cache read]; cache writes cost 1.25x input
const PRICES = { 'claude-fable-5-1': [10, 50, 0.25], 'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5] };

export class BridgeError extends Error {}

// ---------- the bridge: one JSON request per connection to the server's headless Blender ----------
// Safe to send again to a restarted Blender. Never exec: its code may have half-run before Blender died.
const IDEMPOTENT = new Set(['ping', 'scene', 'fingerprint', 'render', 'export_glb', 'save_working', 'snapshot',
                            'restore', 'clear_scene', 'warm_up']);

export function bridge(cmd, args = {}, { timeout = 180000 } = {}) {
  return Sentry.startSpan({ op: 'blender.bridge', name: `blender ${cmd}` }, () => bridgeCall(cmd, args, timeout));
}

async function ready(cmd, after, timeout) {
  try { return await blender.ready({ after, timeout, revive: cmd !== 'ping' }); }
  catch (err) { throw new BridgeError(err.message); }
}

async function attempt(info, cmd, args, timeout) {
  try {
    return await callBlender(info, cmd, args, timeout);
  } catch (err) {
    if (err.code !== 'HOLO_TIMEOUT') throw err;
    // Python on Blender's main thread can't be interrupted (think `while True`): only a restart frees it, and the
    // restarted Blender reopens the working autosave
    blender.restart(`${cmd} ran past ${Math.round(timeout / 1000)} s`);
    throw new BridgeError(`Blender didn't finish ${cmd === 'exec' ? 'that step' : cmd} in time, so it's being restarted.`);
  }
}

// The timeout is how long the command itself may take, measured from the moment Blender is there to run it.
// Waiting for a cold start (about 8 s) or for a restart never counts against it: a retry handed what was left of
// the original budget would time out at once, and attempt() would read that as a stuck Blender and kill the
// healthy one that had just come back.
async function bridgeCall(cmd, args, timeout) {
  let info = await ready(cmd, 0, Math.min(timeout, 90000));
  try {
    return await attempt(info, cmd, args, timeout);
  } catch (err) {
    if (!err.lost) throw err;
    // the connection broke: give the manager a moment to see whether Blender itself died (its exit event lands
    // ~26 ms after the reset); if it didn't, this wasn't a crash and a retry wouldn't help
    for (let i = 0; i < 20 && blender.generation === info.gen && blender.state().state === 'ready'; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (blender.generation === info.gen && blender.state().state === 'ready') throw new BridgeError(err.message);
    if (!IDEMPOTENT.has(cmd)) throw new BridgeError("Blender stopped in the middle of that; it's restarting with the last saved scene.");
    info = await ready(cmd, info.gen, 60000);
    try { return await attempt(info, cmd, args, timeout); }
    catch (e) { throw e.lost ? new BridgeError("Blender stopped again; it's restarting.") : e; }
  }
}

// ---------- the model's instructions and tools ----------
const SYSTEM = `You are a 3D artist working live inside the user's open Blender 5.2, through the tools below. The user says what they want out loud ("make the Mona Lisa", "make the handle thicker") and watches the viewport while you work, so build something genuinely good: recognisable at a glance, well proportioned, with real detail, materials and colour, the way a skilled Blender artist would model it. They will keep editing it by hand afterwards (sculpting, edit mode), so it has to be real, editable Blender content.

How to work
- run_blender_python runs a Python script in the open scene. Build in a few focused steps rather than one giant script, and fix any error it reports.
- look_at_model renders the result so you can see it. Look before you finish, compare it with what the thing really looks like, and fix what's off. One or two rounds of looking and fixing is usually right. You have about 12 tool calls in total; most things need 4 to 8.
- End with one or two plain sentences saying what you made. The user hears about progress from the tool calls, so don't narrate between them.

Research first when it's a specific real thing
- For a particular artwork, landmark, product, vehicle, creature or character, use web_search (and web_fetch for a page worth reading) before modelling, to get the facts that make it recognisable: real dimensions and proportions, colours, materials, distinctive details. Generic things (a mug, a chair) don't need it.
- Web sources are messy and often disagree. Prefer authoritative ones (museums, manufacturers, official specs, encyclopedias), and when numbers conflict, pick one on purpose. In your final sentences, say which key facts you used and where sources disagreed.
- The request comes from speech recognition. If a word looks misheard ("mona leaser"), work out what they meant and say what you assumed.

What the result should be like
- Named objects grouped under one new collection named after the thing (or parented to an Empty), clean topology the user can sculpt or edit, and live, named modifiers where they help (Subdivision Surface, Bevel, Solidify, Mirror, Array). Principled BSDF materials; procedural shader textures, or images you generate with numpy into bpy.data.images, are fine. Web research gives you text, not image files; if a generate_texture tool is available, use it for pictures that would be impractical to paint (a painting's canvas, a poster, a label), otherwise paint or model the detail yourself.
- The finished model is shown in a web viewer as glTF: Principled BSDF values and image textures on a UV map come through, but a procedural texture wired into a BSDF input does not (the web shows plain white there), so give every material its real colour as a plain value or an image.
- No metaballs: glTF has no mesh for them, so they are missing from what the user sees even though your renders show them. Model with meshes, or convert a metaball to a mesh before you finish.
- Metres, Z up, resting on the ground at z = 0, front facing -Y (Blender's front view).
- A new model starts in an empty scene. For a change request, edit the relevant objects in place and keep their names rather than rebuilding everything, and leave objects the request isn't about alone.
- Don't change render settings, cameras, lights or the world unless asked; the preview tool brings its own.

Code limits: it runs in object mode; imports only from bpy, bmesh, mathutils, math, random, numpy, colorsys and the standard maths and collections modules; no file access at all (no open(), and numpy's save/load/savetxt/loadtxt helpers are blocked too), no eval or exec, no os, sys, subprocess or network, no bpy.ops.wm, preferences or script operators, no handlers or timers. Each run is one undo step for the user.`;

const VIEWS = ['front', 'three_quarter', 'side', 'left', 'back', 'top'];
const TOOLS = [
  {
    name: 'run_blender_python',
    description: 'Run a Python script in the open Blender scene. Returns anything printed, the error with the failing line if it raised, the objects it created, and a summary of the scene afterwards.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A few words for this step, shown to the user and used as the Blender undo name, e.g. "frame and canvas".' },
        code: { type: 'string', description: 'The complete Python script.' },
      },
      required: ['label', 'code'],
    },
  },
  {
    name: 'look_at_model',
    description: 'Render the model and look at it. Returns one image per view.',
    input_schema: {
      type: 'object',
      properties: {
        views: { type: 'array', items: { type: 'string', enum: VIEWS }, description: 'Up to 4 camera angles.' },
        objects: { type: 'array', items: { type: 'string' }, description: 'Object names to frame; leave empty to frame everything visible.' },
      },
      required: ['views'],
    },
  },
];

// Anthropic runs these server-side: Fable searches and reads pages itself (Claude Fable 5.1 tool versions)
const RESEARCH_TOOLS = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 4 },
];
const toolsForThisBuild = () => [...TOOLS, ...(research() ? RESEARCH_TOOLS : []), ...(textureToolAvailable() ? [TEXTURE_TOOL] : [])];

const sceneBrief = s => (s?.objects || []).map(o => `${o.name} (${o.type}${o.verts ? `, ${o.verts} verts` : ''}${o.collection ? `, in ${o.collection}` : ''})`).join('; ') || 'empty';

// The request comes from speech recognition, so it may have misheard words. A 'make' arrives in a scene the server
// has just emptied, so there's nothing to read it against; a 'change' may still turn out to be a new thing.
function userMessage(prompt, mode, scene) {
  const note = mode === 'change'
    ? 'it sounds like a change to something already in the scene, but if the scene makes the other reading clearly right, do that'
    : 'they asked for something new, and the scene has been emptied for it';
  return `The user said: "${prompt}"\n(This came from speech recognition, so a word may be misheard; ${note}.)`
    + `\n\nThe scene right now: ${sceneBrief(scene)}.`;
}

function costOf(usage, model) {
  const [pin, pout, pread] = PRICES[model] || PRICES['claude-fable-5-1'];
  const input = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0);
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * pin + (usage.cache_read_input_tokens || 0) * pread + (usage.output_tokens || 0) * pout) / 1e6
    + searches * WEB_SEARCH_USD;
}

// what the page shows for Fable's research: the query, then where it looked
function researchEvent(block) {
  if (block.type === 'server_tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) {
    return { type: 'research', action: block.name === 'web_search' ? 'search' : 'read', query: block.input?.query || block.input?.url || '' };
  }
  if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
    return { type: 'sources', items: block.content.slice(0, 5).map(r => ({ title: r.title, url: r.url })) };
  }
  if (block.type === 'web_fetch_tool_result' && block.content?.url) {
    return { type: 'sources', items: [{ title: block.content.content?.title || block.content.url, url: block.content.url }] };
  }
  return null;
}

// what a run_blender_python result tells the model (renders go separately as images)
function execResultText(r) {
  const brief = {
    ok: r.ok, error: r.error || undefined, printed: r.output || undefined,
    created: (r.new_objects || []).map(o => `${o.name} ${o.type} dims ${o.dimensions?.join('x')}${o.verts ? ` ${o.verts}v/${o.faces}f` : ''}${o.modifiers ? ` mods: ${o.modifiers.join(', ')}` : ''}`),
    scene_objects: r.scene?.object_count,
  };
  return JSON.stringify(brief, null, 1);
}

// every tool call is a gen_ai.execute_tool span in Sentry (AI agent monitoring)
function runTool(block, emit) {
  return Sentry.startSpan({
    op: 'gen_ai.execute_tool', name: `execute_tool ${block.name}`,
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': block.name, 'gen_ai.tool.call.id': block.id,
                  'gen_ai.tool.type': 'function', 'gen_ai.tool.input': JSON.stringify(block.input ?? {}).slice(0, 2000) },
  }, async span => {
    const r = await runToolInner(block, emit);
    span.setAttribute('gen_ai.tool.output', (typeof r.content === 'string' ? r.content : '[image result]').slice(0, 2000));
    if (r.is_error) span.setStatus({ code: 2, message: 'tool_error' });
    return r;
  });
}

async function runToolInner(block, emit) {
  const input = block.input || {};
  if (block.name === 'generate_texture') {
    emit({ type: 'status', text: `Painting a texture: ${String(input.name || '').replace(/_/g, ' ')}` });
    const r = await runTextureTool(input);
    if (r.file) emit({ type: 'step', label: `texture ${input.name}`, state: 'done', created: [] });
    return r;
  }
  if (block.name === 'run_blender_python') {
    if (typeof input.code !== 'string' || !input.code.trim()) {
      return { content: 'The code arrived empty or cut off. Send the complete script again.', is_error: true };
    }
    const label = String(input.label || 'step').slice(0, 60);
    emit({ type: 'step', label, state: 'running' });
    const r = await bridge('exec', { code: input.code, label });
    emit({ type: 'step', label, state: r.ok ? 'done' : 'error', error: r.error, created: (r.new_objects || []).map(o => o.name) });
    return { content: execResultText(r), is_error: !r.ok };
  }
  if (block.name === 'look_at_model') {
    const views = (Array.isArray(input.views) ? input.views : []).filter(v => VIEWS.includes(v)).slice(0, 4);
    emit({ type: 'look', views });
    const r = await bridge('render', { views: views.length ? views : ['three_quarter'], objects: input.objects || [], size: 768 });
    if (!r.ok) return { content: `Couldn't render: ${r.error}`, is_error: true };
    return {
      content: [
        { type: 'text', text: `Rendered ${r.images.map(i => i.view).join(', ')}, framing ${r.framed.length} objects.` },
        ...r.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: i.png } })),
      ],
    };
  }
  return { content: `Unknown tool ${block.name}`, is_error: true };
}

// ---------- the build loop ----------
// emit(event) is called with progress: status, thinking, research, sources, step, look, cost, done.
// The whole build is one gen_ai.invoke_agent span in Sentry, with a gen_ai.chat span per model turn
// and a gen_ai.execute_tool span per tool call.
export function buildInBlender({ prompt, mode = 'make', emit, signal }) {
  const model = blenderModel();
  return Sentry.startSpan({
    op: 'gen_ai.invoke_agent', name: `invoke_agent blender-modeler`, forceTransaction: true,
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'blender-modeler', 'gen_ai.system': 'anthropic',
                  'gen_ai.request.model': model, 'holomodel.prompt': prompt, 'holomodel.mode': mode },
  }, async span => {
    const result = await runBuild({ prompt, mode, emit, signal, model });
    span.setAttribute('holomodel.usd', Number((result.usd || 0).toFixed(4)));
    span.setAttribute('holomodel.turns', result.turns || 0);
    Sentry.logger.info(Sentry.logger.fmt`Blender build finished: ${prompt}`, { usd: result.usd, turns: result.turns, mode });
    return result;
  });
}

async function runBuild({ prompt, mode, emit, signal, model }) {
  if (!env('ANTHROPIC_API_KEY')) throw new Error('Building in Blender needs ANTHROPIC_API_KEY in .env.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const tools = toolsForThisBuild();

  const scene = await bridge('scene', {}, { timeout: 15000 });   // also checks Blender is there before spending anything
  const messages = [{ role: 'user', content: userMessage(prompt, mode, scene) }];
  let usd = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    emit({ type: 'status', text: turn === 0 ? 'Planning the model…' : 'Working…' });
    const msg = await Sentry.startSpan({
      op: 'gen_ai.chat', name: `chat ${model}`,
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'anthropic', 'gen_ai.request.model': model,
                    'gen_ai.request.stream': true, 'gen_ai.request.max_tokens': 64000, 'holomodel.turn': turn },
    }, async span => {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system: SYSTEM,
        tools,
        messages,
        thinking: { type: 'adaptive', display: 'summarized' },   // readable progress notes for the user
        output_config: { effort: effort() },
        cache_control: { type: 'ephemeral' },                     // the conversation (code, renders) is re-sent every turn
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',                                     // if Fable declines, Anthropic's recommended model continues
      }, { signal });

      let thought = '';
      stream.on('thinking', delta => { thought += delta; });
      stream.on('streamEvent', (ev, snapshot) => {
        if (ev.type === 'content_block_stop') {
          if (thought.trim()) { emit({ type: 'thinking', text: thought.trim().slice(0, 600) }); thought = ''; }
          const block = snapshot?.content?.[ev.index];
          const r = block && researchEvent(block);
          if (r) emit(r);
        }
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'tool_use') {
            emit({ type: 'status', text: b.name === 'run_blender_python' ? 'Writing Blender code…'
              : b.name === 'generate_texture' ? 'Planning a texture…' : 'Setting up a preview…' });
          } else if (b.type === 'server_tool_use') {
            emit({ type: 'status', text: b.name === 'web_fetch' ? 'Reading a reference page…' : 'Looking up references…' });
          }
        }
      });

      let m;
      try { m = await stream.finalMessage(); }
      catch (err) {
        if (err instanceof Anthropic.APIError || signal?.aborted) throw err;
        return null;   // eager tool streaming cut a tool call's JSON short: ask again
      }
      const u = m.usage || {};
      span.setAttributes({
        'gen_ai.response.model': m.model || model, 'gen_ai.response.id': m.id, 'gen_ai.response.stop_reason': m.stop_reason || '',
        'gen_ai.usage.input_tokens': u.input_tokens || 0, 'gen_ai.usage.output_tokens': u.output_tokens || 0,
        'gen_ai.usage.total_tokens': (u.input_tokens || 0) + (u.output_tokens || 0),
        'gen_ai.usage.cache_read_input_tokens': u.cache_read_input_tokens || 0,
        'gen_ai.usage.cache_creation_input_tokens': u.cache_creation_input_tokens || 0,
        'gen_ai.response.tool_calls': JSON.stringify(m.content.filter(b => b.type === 'tool_use' || b.type === 'server_tool_use').map(b => b.name)),
        'holomodel.web_searches': u.server_tool_use?.web_search_requests || 0,
      });
      return m;
    });
    if (!msg) { emit({ type: 'status', text: 'A tool call arrived garbled; asking again…' }); continue; }

    usd += costOf(msg.usage, msg.model || model);
    emit({ type: 'cost', usd });

    if (msg.stop_reason === 'refusal') throw new Error(`The model declined this request (${msg.stop_details?.category ?? 'no reason given'}).`);
    if (msg.stop_reason === 'max_tokens') throw new Error('The model ran out of room mid-answer. Try a simpler request.');
    messages.push({ role: 'assistant', content: msg.content });   // thinking and research blocks go back unchanged
    if (msg.stop_reason === 'pause_turn') continue;                // a long server-side search paused the turn: carry on
    const calls = msg.content.filter(b => b.type === 'tool_use');
    if (!calls.length) {
      const summary = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      emit({ type: 'done', summary: summary || 'Done.', usd });
      return { summary, usd, turns: turn + 1 };
    }
    const results = [];
    for (const call of calls) {
      if (signal?.aborted) throw new Error('cancelled');
      let r;
      try { r = await runTool(call, emit); }
      catch (err) {
        if (err instanceof BridgeError) throw err;   // Blender went away: stop the build
        Sentry.captureException(err);
        r = { content: `Tool failed: ${err.message}`, is_error: true };
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  emit({ type: 'done', summary: `Stopped after ${MAX_TURNS} rounds; what's in Blender is where it got to.`, usd });
  return { usd, turns: MAX_TURNS };
}
