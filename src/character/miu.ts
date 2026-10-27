import type { BotStateName } from "../core/layout";
import type { BodyCircle, CharacterEmote, CharacterRenderer } from "./renderer";

const ROOT = "/miu-rig/assets";
const LAYERS = ["shadow", "tail", "body", "foreleg_L", "foreleg_R", "collar", "pendant", "ear_L", "ear_R", "head", "blush_L", "blush_R", "eye_white_L", "eye_white_R", "iris_L", "iris_R", "brow_L", "brow_R", "nose", "mouth_smile"];
type Pose = { eyes: string; mouth: string };
const STATES: Record<BotStateName, Pose> = {
  idle: { eyes: "normal", mouth: "mouth_smile" },
  working: { eyes: "normal", mouth: "mouth_closed" },
  thinking: { eyes: "normal", mouth: "mouth_closed" },
  searching: { eyes: "normal", mouth: "mouth_closed" },
  approval: { eyes: "eyes_dot", mouth: "mouth_o" },
  question: { eyes: "eyes_dot", mouth: "mouth_o" },
  error: { eyes: "eyes_spiral", mouth: "mouth_wavy" },
  finished: { eyes: "eyes_happy", mouth: "mouth_grin" },
  ratelimit: { eyes: "eyes_line", mouth: "mouth_flat" },
  sleeping: { eyes: "eyes_closed", mouth: "mouth_closed" },
  dizzy: { eyes: "eyes_spiral", mouth: "mouth_wavy" },
};
const EMOTES: Record<CharacterEmote, Pose> = {
  love: { eyes: "eyes_heart", mouth: "mouth_smile" },
  surprised: { eyes: "eyes_dot", mouth: "mouth_o" },
  proud: { eyes: "eyes_star", mouth: "mouth_grin" },
  wink: { eyes: "eyes_wink_L", mouth: "mouth_closed" },
  yawn: { eyes: "eyes_closed", mouth: "mouth_yawn" },
  happy: { eyes: "eyes_happy", mouth: "mouth_grin" },
  annoyed: { eyes: "eyes_line", mouth: "mouth_flat" },
  greeting: { eyes: "eyes_happy", mouth: "mouth_grin" },
};

export class MiuRenderer implements CharacterRenderer {
  readonly canvas = document.createElement("canvas");
  readonly ready: Promise<void>;
  private images = new Map<string, HTMLImageElement>();
  private loading = new Map<string, Promise<HTMLImageElement>>();
  private irisCanvas = document.createElement("canvas");
  private size = 108;
  private padding = 17;
  private state: BotStateName = "idle";
  private emote: Pose | null = null;
  private emoteTimer = 0;
  private lookX = 0;
  private lookY = 0;
  private dancing = false;
  private dragged = false;
  private hover = false;
  private reduced = false;
  private paused = false;
  private destroyed = false;
  private loaded = false;
  private frameId = 0;
  private lastFrame = 0;
  private clock = 0;

  constructor() {
    this.canvas.className = "character";
    this.canvas.setAttribute("aria-label", "Miu");
    this.setSize(92);
    this.ready = Promise.all([
      ...LAYERS.map(name => this.load(`layers/${name}`)),
      this.load("variants/eyes_closed"),
    ]).then(() => { this.loaded = true; this.kick(); });
    void this.ready.catch(error => {
      if (this.destroyed) return;
      this.canvas.dataset.error = "assets";
      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#e84d6f";
        ctx.fillText("Aset Miu gagal dimuat", 4, 24);
      }
      console.error("Miu assets:", error);
    });
  }

  get width() { return this.size + this.padding * 2; }
  get height() { return this.width; }
  get footGap() { return this.padding + this.size * 14 / 1024; }
  body(): BodyCircle {
    return { cx: this.padding + this.size * 0.48, cy: this.padding + this.size * 0.53, r: this.size * 0.46 };
  }
  setSize(bodySize: number) {
    this.size = Math.max(48, Math.round(bodySize / 0.86));
    this.padding = Math.round(this.size * 0.16);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.irisCanvas.width = this.irisCanvas.height = Math.max(1, Math.round(this.size*dpr));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.kick();
  }
  setState(state: BotStateName) { this.state = state; this.kick(); }
  setLook(x: number, y: number) {
    const lx = Math.max(-1, Math.min(1, x));
    const ly = Math.max(-1, Math.min(1, -y));
    if (Math.abs(lx-this.lookX)<0.01 && Math.abs(ly-this.lookY)<0.01) return;
    this.lookX = lx; this.lookY = ly;
    if (!this.reduced) this.kick();
  }
  playEmote(emote: CharacterEmote) { this.flash(EMOTES[emote], emote === "greeting" ? 2000 : 1700); }
  playIntro() { this.playEmote("greeting"); }
  poke() { this.playEmote("wink"); }
  setDragged(on: boolean) { this.dragged = on; this.kick(); }
  setDropHover(on: boolean) { this.hover = on; this.kick(); }
  swallow() { this.flash({ eyes: "eyes_happy", mouth: "mouth_chew" }, 1600); }
  setDancing(on: boolean) { this.dancing = on; this.kick(); }
  setReducedMotion(on: boolean) { this.reduced = on; this.kick(); }
  pause() {
    this.paused = true;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }
  resume() { this.paused = false; this.lastFrame = 0; this.kick(); }
  destroy() {
    this.destroyed = true;
    this.pause();
    clearTimeout(this.emoteTimer);
    this.images.clear();
    this.canvas.remove();
  }

  private flash(pose: Pose, duration: number) {
    this.emote = pose;
    clearTimeout(this.emoteTimer);
    this.emoteTimer = window.setTimeout(() => { this.emote = null; this.kick(); }, duration);
    this.kick();
  }
  private load(key: string): Promise<HTMLImageElement> {
    const existing = this.loading.get(key);
    if (existing) return existing;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (!this.destroyed) { this.images.set(key, image); this.kick(); }
        resolve(image);
      };
      image.onerror = () => reject(new Error(key));
      image.src = `${ROOT}/${key}.png`;
    });
    this.loading.set(key, promise);
    return promise;
  }
  private image(key: string): HTMLImageElement | undefined {
    const image = this.images.get(key);
    if (!image && !this.loading.has(key)) void this.load(key).catch(error => console.error("Miu variant:", error));
    return image;
  }
  private kick() {
    if (this.frameId || this.paused || this.destroyed || !this.loaded) return;
    this.frameId = requestAnimationFrame(this.frame);
  }
  private frame = (now: number) => {
    this.frameId = 0;
    if (this.paused || this.destroyed) return;
    const dt = this.lastFrame ? now-this.lastFrame : 34;
    if (dt >= 32 || this.reduced) {
      this.lastFrame = now;
      if (!this.reduced) this.clock += Math.min(dt, 100) / 1000;
      this.draw();
    }
    if (!this.reduced) this.kick();
  };

  private part(ctx: CanvasRenderingContext2D, name: string, angle = 0, pivot: readonly number[] = [0,0]) {
    const image = this.image(name.includes("/") ? name : `layers/${name}`);
    if (!image) return;
    ctx.save();
    ctx.translate(pivot[0], pivot[1]);
    ctx.rotate(angle * Math.PI / 180);
    ctx.translate(-pivot[0], -pivot[1]);
    ctx.drawImage(image, 0, 0, 1024, 1024);
    ctx.restore();
  }
  private iris(ctx: CanvasRenderingContext2D, side: string, x: number, y: number) {
    const off = this.irisCanvas.getContext("2d");
    const iris = this.images.get(`layers/iris_${side}`);
    const white = this.images.get(`layers/eye_white_${side}`);
    if (!off || !iris || !white) return;
    const scale = this.irisCanvas.width/1024;
    off.setTransform(scale,0,0,scale,0,0);
    off.clearRect(0,0,1024,1024);
    off.globalCompositeOperation = "source-over";
    off.drawImage(iris,x,y,1024,1024);
    off.globalCompositeOperation = "destination-in";
    off.drawImage(white,0,0,1024,1024);
    off.globalCompositeOperation = "source-over";
    ctx.drawImage(this.irisCanvas,0,0,1024,1024);
  }
  private draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const t = this.reduced ? 0 : this.clock;
    const calm = ["idle","working","thinking","searching","finished"].includes(this.state);
    const dance = this.dancing && calm && !this.reduced && !this.dragged && !this.hover;
    let pose = this.emote ?? STATES[this.state];
    if (this.dragged) pose = { eyes: "eyes_dot", mouth: "mouth_o" };
    else if (this.hover) pose = { eyes: "eyes_star", mouth: "mouth_open_wide" };
    else if (dance && !this.emote) pose = { eyes: "eyes_happy", mouth: ["mouth_sing_a","mouth_sing_e","mouth_sing_o"][Math.floor(t*5)%3] };
    const sleeping = this.state === "sleeping";
    const blink = !this.reduced && pose.eyes === "normal" && t%5.3 > 5.12;
    const lx = this.reduced || sleeping ? 0 : this.lookX;
    const ly = this.reduced || sleeping ? 0 : this.lookY;
    const headAngle = this.reduced ? 0 : lx*6 + Math.sin(t*(dance?6:1.5))*(dance?8:1.5);
    const breath = this.reduced ? 0 : Math.sin(t*(dance?8:2.5))*(dance?8:3);
    const dpr = this.canvas.width/this.width;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,this.width,this.height);
    ctx.translate(this.padding,this.padding);
    ctx.scale(this.size/1024,this.size/1024);
    this.part(ctx,"shadow");
    this.part(ctx,"tail",Math.sin(t*(dance?11.2:3.5))*12,[730,910]);
    ctx.save();
    ctx.translate(481.28,1010);
    ctx.scale(1,1+(this.reduced?0:Math.sin(t*(dance?8:2.5))*0.015));
    ctx.translate(-481.28,-1010);
    for (const part of ["body","foreleg_L","foreleg_R","collar"]) this.part(ctx,part);
    ctx.restore();
    ctx.save();
    ctx.translate(lx*10,ly*8+breath);
    ctx.translate(481.28,563.2);
    ctx.rotate(headAngle*Math.PI/180);
    ctx.translate(-481.28,-563.2);
    this.part(ctx,"ear_L",Math.sin(t*3)*2-lx*1.5,[145,303]);
    this.part(ctx,"ear_R",-Math.sin(t*3)*2-lx*1.5,[846,326]);
    for (const part of ["head","blush_L","blush_R"]) this.part(ctx,part);
    const eyes = blink ? "eyes_closed" : pose.eyes;
    if (eyes === "normal" || !this.image(`variants/${eyes}`)) {
      for (const side of ["L","R"]) {
        this.part(ctx,`eye_white_${side}`);
        const scan = this.state === "searching" && !this.reduced ? Math.sin(t*2)*2 : 0;
        const gazeX = Math.max(-4,Math.min(4,lx*4+scan));
        const gazeY = Math.max(-3,Math.min(3,ly*3+(this.state === "thinking" ? -2 : 0)));
        this.iris(ctx,side,gazeX,gazeY);
      }
    } else this.part(ctx,`variants/${eyes}`);
    for (const part of ["brow_L","brow_R","nose"]) this.part(ctx,part);
    if (pose.mouth === "mouth_smile" || !this.image(`variants/${pose.mouth}`)) this.part(ctx,"mouth_smile");
    else this.part(ctx,`variants/${pose.mouth}`);
    if (dance) this.part(ctx,"variants/prop_disco_shades");
    ctx.restore();
    ctx.save();
    ctx.translate(481.28,1010);
    ctx.scale(1,1+(this.reduced?0:Math.sin(t*(dance?8:2.5))*0.015));
    ctx.translate(-481.28,-1010);
    this.part(ctx,"pendant");
    ctx.restore();
  }
}
