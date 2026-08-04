/**
 * Safety limiter on the sum of every track, before the master fader.
 *
 * Each track's granulator already limits its own output to roughly +/-1, so one
 * track needs nothing here. Four of them summing do: at full level the sum can
 * reach ~3.2, which the output device would hard-clip.
 *
 * It is deliberately the *same* curve the granulator uses rather than a new
 * character, and it is deliberately not a DynamicsCompressorNode -- a compressor
 * with a threshold low enough to catch four tracks would engage on the plucks of
 * one, changing how patches that already exist sound. This form is exact identity
 * below KNEE, and a track at the default level 0.8 peaks at exactly KNEE, so a
 * single-track patch passes through untouched.
 *
 * Fader after limiter, not before: the master fader is a level control, not a
 * drive control, so turning it down must not change the timbre.
 *
 * Self-contained: AudioWorkletGlobalScope has no module loader, so softClip is
 * duplicated from granulator-processor.js rather than imported. A test asserts
 * the two copies stay identical.
 */

/** Below this level the limiter is bypassed entirely. */
const KNEE = 0.8;

function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return x;
  const u = (a - KNEE) / (1 - KNEE);
  const limited = KNEE + (1 - KNEE) * (u / (1 + u));
  return x < 0 ? -limited : limited;
}

class MasterClipProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0][0];
    // No connected source yet: emit silence rather than reading undefined.
    if (!input || !input[0]) {
      out.fill(0);
      return true;
    }
    const src = input[0];
    for (let i = 0; i < out.length; i += 1) out[i] = softClip(src[i]);
    return true;
  }
}

registerProcessor('master-clip-processor', MasterClipProcessor);
