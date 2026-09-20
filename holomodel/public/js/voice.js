// Continuous speech recognition with the Web Speech API. Edge supports it. Brave exposes the API
// but blocks the speech service, so it fails with a "network" error there.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// states: 'off' | 'listening' | 'unsupported' | 'blocked' (mic permission denied) | 'network' | 'error'
export function createVoice({ onInterim, onFinal, onState, lang = 'en-US' }) {
  let rec = null, wanted = false, state = SR ? 'off' : 'unsupported', sessionStart = 0, lastError = '';
  let quickFails = [], muted = false;
  const set = s => { if (s !== state) { state = s; onState?.(s); } };

  function start() {
    if (!SR) { set('unsupported'); return; }
    wanted = true;
    if (rec) return;
    lastError = '';
    rec = new SR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onstart = () => { sessionStart = performance.now(); set('listening'); };
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { const t = r[0].transcript.trim(); if (t && !muted) onFinal?.(t); }
        else interim += r[0].transcript;
      }
      onInterim?.(interim.trim());
    };
    rec.onerror = e => {
      lastError = e.error;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; set('blocked'); }
      // 'no-speech', 'aborted' and friends just end the session; onend restarts it
    };
    rec.onend = () => {
      rec = null;
      if (!wanted) { if (state === 'listening') set('off'); return; }
      // Sessions end on their own after silence; restart. Give up if they keep dying instantly (no speech service).
      const now = performance.now();
      if (now - sessionStart < 2000) quickFails.push(now);
      quickFails = quickFails.filter(t => now - t < 15000);
      if (quickFails.length >= 4) {
        wanted = false; quickFails = [];
        set(lastError === 'network' ? 'network' : 'error');
        return;
      }
      setTimeout(() => { if (wanted) start(); }, quickFails.length ? 800 : 50);
    };
    sessionStart = performance.now();   // onstart may never fire when the service is unreachable
    try { rec.start(); } catch (err) { rec = null; wanted = false; set('error'); }
  }

  function stop() {
    wanted = false;
    if (rec) rec.stop();
    set('off');
  }

  return {
    start, stop,
    toggle() { wanted ? stop() : start(); return wanted; },
    mute(on) { muted = on; },   // while the app is talking, ignore what it hears (itself)
    get state() { return state; },
    get wanted() { return wanted; },
    supported: !!SR,
    engine: 'browser',
  };
}

// ElevenLabs (when the server has a key): the mic is always recording; a simple level detector finds where each
// utterance ends, and that stretch of audio goes to /api/voice/transcribe (Scribe v2). Since the recorder is
// already running when you start talking, the first word isn't clipped. Works in any browser, Brave included.
const SPEECH_RMS = 0.022, SILENCE_MS = 750, MIN_SPEECH_MS = 280, MAX_UTTERANCE_MS = 15000, IDLE_RESTART_MS = 3000;
const LEVEL_WORKLET = URL.createObjectURL(new Blob([`
registerProcessor('level-meter', class extends AudioWorkletProcessor {
  sum = 0; n = 0;
  process([input]) {
    const ch = input[0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.sum += ch[i] * ch[i]; this.n++; }
    if (this.n >= sampleRate / 40) { this.port.postMessage(Math.sqrt(this.sum / this.n)); this.sum = 0; this.n = 0; }
    return true;
  }
});`], { type: 'text/javascript' }));

export function createCloudVoice({ onInterim, onFinal, onState, onFail }) {
  let wanted = false, state = 'off', stream = null, ctx = null, rec = null;
  let chunks = [], recStart = 0, speechStart = 0, lastLoud = 0, speaking = false, muted = false;
  const set = s => { if (s !== state) { state = s; onState?.(s); } };
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';

  function newRecorder() {
    const mine = [];   // its own list: a stopped recorder's last data arrives after the next one has started
    chunks = mine;
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data.size) mine.push(e.data); };
    rec.start();
    recStart = performance.now();
  }

  // ends the current recording; send it if it held speech, and start the next one straight away
  function cut(send) {
    const old = rec, oldChunks = chunks;
    old.onstop = () => { if (send) upload(new Blob(oldChunks, { type: old.mimeType || 'audio/webm' })); };
    old.stop();
    if (wanted) newRecorder();
  }

  let failures = 0;
  async function upload(blob) {
    onInterim?.('…');
    try {
      const r = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || `transcription failed (${r.status})`);
      failures = 0;
      onInterim?.('');
      if (data.text) onFinal?.(data.text);
    } catch (err) {
      onInterim?.('');
      console.warn('ElevenLabs transcription failed:', err.message);
      if (++failures >= 3) { stop(); onFail?.(err); }   // e.g. a bad key: fall back to the browser's recogniser
    }
  }

  // called ~40 times a second with the mic level, from the audio thread (keeps going while Blender covers this window)
  function onLevel(rms) {
    if (!wanted || !rec) return;
    const loud = rms > SPEECH_RMS && !muted;
    const now = performance.now();
    if (loud) {
      lastLoud = now;
      if (!speaking) { speaking = true; speechStart = now; onInterim?.('🎙'); }
    }
    if (speaking) {
      const quietFor = now - lastLoud, long = now - speechStart > MAX_UTTERANCE_MS;
      if (quietFor > SILENCE_MS || long) {
        speaking = false;
        const real = lastLoud - speechStart > MIN_SPEECH_MS;   // not just a cough or a click
        if (!real) onInterim?.('');
        cut(real);
      }
    } else if (now - recStart > IDLE_RESTART_MS) {
      cut(false);   // keeps leading silence short (it's billed by length)
    }
  }

  async function start() {
    wanted = true;
    if (stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      wanted = false;
      set(err.name === 'NotAllowedError' ? 'blocked' : 'error');
      return;
    }
    if (!wanted) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }
    try {
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule(LEVEL_WORKLET);
      if (!wanted) return;
      const meter = new AudioWorkletNode(ctx, 'level-meter');
      meter.port.onmessage = e => onLevel(e.data);
      const silent = ctx.createGain();
      silent.gain.value = 0;   // wired to the speakers (silently) so the browser keeps running the meter
      ctx.createMediaStreamSource(stream).connect(meter).connect(silent).connect(ctx.destination);
      await ctx.resume();
      newRecorder();
      set('listening');
    } catch (err) {
      console.error('voice: audio setup failed', err);
      stop();
      set('error');
    }
  }

  function stop() {
    wanted = false;
    if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); }
    rec = null;
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    ctx?.close();
    ctx = null;
    speaking = false;
    set('off');
  }

  return {
    start, stop,
    toggle() { wanted ? stop() : start(); return wanted; },
    // while the app is talking, don't record it hearing itself
    mute(on) { muted = on; if (on && speaking && rec) { speaking = false; onInterim?.(''); cut(false); } },
    get state() { return state; },
    get wanted() { return wanted; },
    supported: !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
    engine: 'elevenlabs',
  };
}
