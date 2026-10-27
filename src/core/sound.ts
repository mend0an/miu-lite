// Short oscillator cues; no recordings or external audio assets.
const tones: Record<string, [number, number]> = {
  open: [440, 560], close: [560, 440], send: [640, 800],
  finish: [660, 880], error: [260, 200], rate: [300, 240],
  approval: [480, 600], question: [520, 620], love: [720, 860],
};

class SoundEngine {
  enabled = true;
  volume = 0.12;
  private ctx: AudioContext | null = null;
  private idleTimer: number | null = null;
  private playing = new Map<string, Set<{ oscillator: OscillatorNode; gain: GainNode }>>();

  preload(): Promise<void> {
    try {
      this.ctx ??= new AudioContext();
    } catch {
      // Audio is optional when a device or Web Audio is unavailable.
    }
    return Promise.resolve();
  }

  resume() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    void this.ctx?.resume().catch(() => {});
  }

  idle() {
    if (!this.ctx || this.idleTimer !== null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend().catch(() => {});
    }, 1500);
  }

  setVolume(value: number) {
    this.volume = Number.isFinite(value) ? Math.max(0, Math.min(0.2, value)) : 0.12;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) for (const name of this.playing.keys()) this.fadeOut(name, 0.02);
  }

  play(name: string) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || this.volume === 0 || ctx.state === "closed") return;
    this.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const [from, to] = tones[name] ?? [560, 650];
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + 0.12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.volume * 0.35, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.16);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    const entry = { oscillator, gain };
    let active = this.playing.get(name);
    if (!active) this.playing.set(name, active = new Set());
    active.add(entry);
    oscillator.onended = () => {
      active.delete(entry);
      if (!active.size) this.playing.delete(name);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(now + 0.17);
  }

  fadeOut(name: string, seconds: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const end = ctx.currentTime + Math.max(0.01, seconds);
    for (const { oscillator, gain } of this.playing.get(name) ?? []) {
      gain.gain.cancelAndHoldAtTime(ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.stop(end);
    }
  }
}

export const Sound = new SoundEngine();
