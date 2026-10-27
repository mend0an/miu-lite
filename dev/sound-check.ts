import { Sound } from "../src/core/sound";

const button = document.querySelector<HTMLButtonElement>("#run")!;
button.onclick = async () => {
  button.disabled = true;
  const results: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    results.push(message);
  };
  try {
    await Sound.preload();
    const audio = Sound as unknown as { ctx: AudioContext; playing: Map<string, Set<unknown>> };
    await audio.ctx.resume();
    Sound.setVolume(1);
    check(Sound.volume === 0.2, "volume is bounded");
    Sound.setEnabled(false);
    Sound.play("open");
    check(audio.playing.size === 0, "disabled sound creates no voice");
    Sound.setEnabled(true);
    Sound.play("open");
    Sound.play("finish");
    check(audio.playing.size === 2, "overlapping cues are scheduled");
    Sound.fadeOut("open", 0.02);
    await new Promise(resolve => setTimeout(resolve, 350));
    check(audio.playing.size === 0, "ended and faded voices are released");
    Sound.setVolume(0);
    Sound.play("send");
    check(audio.playing.size === 0, "zero volume creates no voice");
    Sound.setVolume(0.12);
    Sound.idle();
    await new Promise(resolve => setTimeout(resolve, 1700));
    check(audio.ctx.state === "suspended", "idle audio suspends");
    Sound.resume();
    await audio.ctx.resume();
    check(audio.ctx.state === "running", "user activity resumes audio");
    await audio.ctx.close();
    (window as unknown as { __soundQa: unknown }).__soundQa = { ok: true, results };
    document.querySelector("#result")!.textContent = "PASS\n" + results.join("\n");
  } catch (error) {
    (window as unknown as { __soundQa: unknown }).__soundQa = { ok: false, error: String(error) };
    document.querySelector("#result")!.textContent = String(error);
  }
};
