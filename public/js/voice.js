// Continuous speech recognition with the Web Speech API. Edge supports it. Brave exposes the API
// but blocks the speech service, so it fails with a "network" error there.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// states: 'off' | 'listening' | 'unsupported' | 'blocked' (mic permission denied) | 'network' | 'error'
export function createVoice({ onInterim, onFinal, onState, lang = 'en-US' }) {
  let rec = null, wanted = false, state = SR ? 'off' : 'unsupported', sessionStart = 0, lastError = '';
  let quickFails = [];
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
        if (r.isFinal) { const t = r[0].transcript.trim(); if (t) onFinal?.(t); }
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
    get state() { return state; },
    get wanted() { return wanted; },
    supported: !!SR,
  };
}
