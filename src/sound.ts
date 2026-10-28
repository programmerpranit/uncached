// Spin sound effects, synthesized with the Web Audio API so there are no audio files to ship.
// The AudioContext is created lazily on the first spin, which always follows a click or key
// press, so browsers' autoplay rules allow it.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null

function audio(): { ac: AudioContext; out: GainNode } | null {
  if (!ctx) {
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.55
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return { ac: ctx, out: master! }
}

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (!noise) {
    noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.6), ac.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return noise
}

/** A soft whoosh as the reel starts moving. */
export function playStart() {
  const a = audio()
  if (!a) return
  const { ac, out } = a
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noiseBuffer(ac)
  const filter = ac.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 1.2
  filter.frequency.setValueAtTime(300, t)
  filter.frequency.exponentialRampToValueAtTime(2400, t + 0.45)
  const gain = ac.createGain()
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.12)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
  src.connect(filter).connect(gain).connect(out)
  src.start(t)
  src.stop(t + 0.6)
}

/**
 * One mechanical click of the reel. `progress` runs from 0 to 1 over the spin;
 * the click drops in pitch and gets a little heavier as the reel slows down.
 */
export function playTick(progress: number) {
  const a = audio()
  if (!a) return
  const { ac, out } = a
  const t = ac.currentTime

  // Filtered noise gives the ratchet "tk" texture.
  const src = ac.createBufferSource()
  src.buffer = noiseBuffer(ac)
  const filter = ac.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 6
  filter.frequency.value = 3200 - 1600 * progress
  const clickGain = ac.createGain()
  clickGain.gain.setValueAtTime(0.5 + 0.3 * progress, t)
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
  src.connect(filter).connect(clickGain).connect(out)
  src.start(t, Math.random() * 0.5)
  src.stop(t + 0.04)

  // A short pitched blip underneath gives each tick some body.
  const osc = ac.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = 900 - 380 * progress
  const blipGain = ac.createGain()
  blipGain.gain.setValueAtTime(0.0001, t)
  blipGain.gain.exponentialRampToValueAtTime(0.12, t + 0.003)
  blipGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
  osc.connect(blipGain).connect(out)
  osc.start(t)
  osc.stop(t + 0.06)
}

/** A bright, bell-like chord when the topic lands. */
export function playLand() {
  const a = audio()
  if (!a) return
  const { ac, out } = a
  const t = ac.currentTime
  // C major arpeggio, slightly staggered so it rings rather than thuds.
  ;[523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const start = t + i * 0.055
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    // A quiet overtone an octave and a fifth up adds the bell shimmer.
    const over = ac.createOscillator()
    over.type = 'sine'
    over.frequency.value = freq * 3
    const overGain = ac.createGain()
    overGain.gain.value = 0.08
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.6)
    osc.connect(gain)
    over.connect(overGain).connect(gain)
    gain.connect(out)
    osc.start(start)
    over.start(start)
    osc.stop(start + 1.7)
    over.stop(start + 1.7)
  })
}
