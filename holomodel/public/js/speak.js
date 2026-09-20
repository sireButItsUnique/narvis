// Talking back: short spoken replies ("Done: a mug with a gold rim"). ElevenLabs when the server has a key,
// otherwise the browser's own voice. The mic ignores what it hears while this is talking.
export function createSpeaker({ engine = 'browser', onTalking } = {}) {
  let audio = null, gen = 0;
  const talking = on => onTalking?.(on);

  function browserSay(text) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.onstart = () => talking(true);
    u.onend = u.onerror = () => talking(false);
    speechSynthesis.speak(u);
  }

  async function say(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    stop();
    const mine = ++gen;
    if (engine !== 'elevenlabs') return browserSay(text);
    try {
      const r = await fetch('/api/voice/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `speech failed (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      if (mine !== gen) return URL.revokeObjectURL(url);   // something newer started talking meanwhile
      audio = new Audio(url);
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); talking(false); };
      talking(true);
      await audio.play();
    } catch (err) {
      console.warn('ElevenLabs speech failed, using the browser voice:', err.message);
      talking(false);
      if (mine === gen) browserSay(text);
    }
  }

  function stop() {
    gen++;
    if (audio) { audio.pause(); audio = null; }
    window.speechSynthesis?.cancel();
    talking(false);
  }

  return { say, stop, get engine() { return engine; } };
}

// what's worth saying out loud from a longer text: the first sentence or two
export function speakable(text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const sentences = s.match(/[^.!?]+[.!?]+/g) || [s];
  let out = '';
  for (const x of sentences) { if ((out + x).length > max) break; out += x; }
  return (out || s.slice(0, max)).trim();
}
