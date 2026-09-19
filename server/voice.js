// ElevenLabs voice. Scribe v2 transcribes what you say: it copes with a noisy hackathon floor and knows words like
// "sculpt" and "Blender", where the browser's recogniser often doesn't. A real voice answers back when a build
// finishes. Off until ELEVENLABS_API_KEY is set; the page then uses Edge's own speech recognition and voice.
import { Readable } from 'node:stream';
import * as Sentry from '@sentry/node';

const env = name => (process.env[name] || '').trim();
export const voiceAvailable = () => !!env('ELEVENLABS_API_KEY');
const STT_MODEL = () => env('ELEVENLABS_STT_MODEL') || 'scribe_v2';
const TTS_MODEL = () => env('ELEVENLABS_TTS_MODEL') || 'eleven_flash_v2_5';   // the low-latency one
const VOICE_ID = () => env('ELEVENLABS_VOICE_ID') || 'JBFqnCBsd6RMkjVDRZzb';   // "George", a premade voice every account has

// words the recogniser should expect: the commands, and Blender's vocabulary
const KEYTERMS = ['Blender', 'sculpt mode', 'edit mode', 'object mode', 'clay strips', 'grab brush', 'smooth brush',
                  'inflate brush', 'crease brush', 'mirror on', 'mirror off', 'bigger brush', 'smaller brush',
                  'save version', 'go back to version', 'show versions', 'undo', 'redo', 'cancel', 'frame it'];

export class VoiceError extends Error {}

let client = null;
async function eleven() {
  if (!voiceAvailable()) throw new VoiceError('No ELEVENLABS_API_KEY in .env, so the page uses the browser\'s voice.');
  if (!client) {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    client = new ElevenLabsClient({ apiKey: env('ELEVENLABS_API_KEY'), baseUrl: env('ELEVENLABS_BASE_URL') || undefined });
  }
  return client;
}

// the SDK takes several seconds to load the first time; do it at startup, not on the first thing you say
export const warmUp = () => (voiceAvailable() ? eleven().then(() => true, () => false) : Promise.resolve(false));

// audio: a Buffer of one utterance as the page recorded it (webm/opus from MediaRecorder)
export function transcribe(audio, contentType, signal) {
  return Sentry.startSpan({ op: 'voice.transcribe', name: 'ElevenLabs speech to text',
                            attributes: { 'voice.model': STT_MODEL(), 'voice.bytes': audio.length } }, async span => {
    const c = await eleven();
    const r = await c.speechToText.convert({
      file: { data: audio, filename: `speech.${contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'm4a' : 'webm'}`, contentType },
      modelId: STT_MODEL(),
      languageCode: env('ELEVENLABS_LANGUAGE') || 'en',
      tagAudioEvents: false,   // no "(laughs)" in commands
      noVerbatim: true,        // drops "um" and false starts
      keyterms: KEYTERMS,
    }, { abortSignal: signal, timeoutInSeconds: 30 });
    const text = String(r.text ?? r.transcripts?.[0]?.text ?? '').trim();
    span.setAttribute('voice.text', text.slice(0, 200));
    return text;
  });
}

// returns a Node stream of MP3 audio
export function speak(text, signal) {
  return Sentry.startSpan({ op: 'voice.speak', name: 'ElevenLabs text to speech',
                            attributes: { 'voice.model': TTS_MODEL(), 'voice.chars': text.length } }, async () => {
    const c = await eleven();
    const audio = await c.textToSpeech.convert(VOICE_ID(), {
      text, modelId: TTS_MODEL(), outputFormat: 'mp3_44100_128',
    }, { abortSignal: signal, timeoutInSeconds: 30 });
    return Readable.fromWeb(audio);
  });
}
