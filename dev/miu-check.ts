import { MiuRenderer } from "../src/character/miu";
import type { BotStateName } from "../src/core/layout";

const results: string[] = [];
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let testTime = performance.now();
// Drive frames explicitly so this fixture also works in a hidden browser window.
window.requestAnimationFrame = callback => { pendingFrames.set(++nextFrame,callback); return nextFrame; };
window.cancelAnimationFrame = id => { pendingFrames.delete(id); };
async function frame() {
  await Promise.resolve();
  const callbacks = [...pendingFrames.values()];
  pendingFrames.clear();
  testTime += 34;
  for (const callback of callbacks) callback(testTime);
  await Promise.resolve();
}
const r = new MiuRenderer();
const internals = r as unknown as { loading: Map<string, Promise<HTMLImageElement>>; frameId: number; irisCanvas: HTMLCanvasElement };
const states: BotStateName[] = ["idle","thinking","working","searching","approval","question","error","finished","ratelimit","sleeping","dizzy"];
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); results.push(message); };

async function settle() {
  await r.ready;
  await frame();
  await Promise.all(internals.loading.values());
  await frame();
}
function signature() {
  const pixels = r.canvas.getContext("2d")!.getImageData(0,0,r.canvas.width,r.canvas.height).data;
  let hash = 2166136261;
  for (const pixel of pixels) hash = Math.imul(hash^pixel,16777619);
  return hash >>> 0;
}
function capture(label: string) {
  const cell = document.createElement("figure");
  const image = document.createElement("canvas");
  image.width = r.canvas.width; image.height = r.canvas.height;
  image.getContext("2d")!.drawImage(r.canvas,0,0);
  image.dataset.state = label;
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  cell.append(image,caption);
  document.getElementById("states")!.append(cell);
}
async function main() {
  r.setSize(180);
  r.setReducedMotion(true);
  await settle();
  const hashes = new Set<number>();
  for (const state of states) {
    r.setState(state);
    await settle();
    const pixels = r.canvas.getContext("2d")!.getImageData(0,0,r.canvas.width,r.canvas.height).data;
    check(pixels.some((v,i) => i%4===3 && v>240),`${state}: rendered`);
    hashes.add(signature());
    capture(state);
  }
  check(hashes.size>=7,"states use distinct facial poses");
  const sleeping = signature();
  r.pause();
  r.setState("idle");
  await frame();
  check(signature()===sleeping,"pause freezes the canvas");
  r.resume();
  await settle();
  check(signature()!==sleeping,"resume paints the latest state");
  const idle = signature();
  for (let i=0;i<4;i++) await frame();
  check(signature()===idle,"reduced motion remains still");
  r.setDancing(true);
  await settle();
  check(signature()===idle,"reduced motion suppresses dance");
  r.setDancing(false);
  r.setDropHover(true);
  await settle();
  check(signature()!==idle,"file hover changes the pose");
  r.setDropHover(false);
  r.setDragged(true);
  await settle();
  check(signature()!==idle,"dragged pose is available");
  r.setDragged(false);
  r.playEmote("love");
  await settle();
  check(signature()!==idle,"love emote is available");
  capture("love");
  r.setState("working");
  await new Promise(resolve=>setTimeout(resolve,1800));
  await settle();
  check(signature()!==idle,"emote returns to the active task state");
  r.setSize(72);
  await settle();
  check(r.canvas.width>0 && r.body().r>0 && r.footGap>0,"resize updates canvas and hit area");
  r.setSize(180);
  r.setState("idle");
  r.setReducedMotion(false);
  r.setLook(1,-1);
  await settle();
  capture("gaze");
  r.setDancing(true);
  await settle();
  capture("dance");
  r.setState("sleeping");
  r.setReducedMotion(true);
  await settle();
  capture("sleeping_after_dance");
  r.pause();
  const transient = new MiuRenderer();
  transient.destroy();
  await transient.ready;
  await frame();
  check(!transient.canvas.isConnected,"destroy during loading does not reattach canvas");
  r.destroy();
  check(internals.frameId===0,"destroy cancels animation");
  const report = {ok:true,results,states:states.length,distinctPoses:hashes.size};
  (window as unknown as {__miuQa:unknown}).__miuQa = report;
  document.getElementById("results")!.textContent = JSON.stringify(report,null,2);
}
void main().catch(error => {
  const report = {ok:false,results,error:String(error)};
  (window as unknown as {__miuQa:unknown}).__miuQa = report;
  document.getElementById("results")!.textContent = JSON.stringify(report,null,2);
  r.destroy();
});
