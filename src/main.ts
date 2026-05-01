import "./style.css";
import JSZip from "jszip";
import { parseGIF, decompressFrames } from "gifuct-js";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

interface State {
  x: number;
  y: number;
  scale: number;
  baseScale: number;
}

interface Target {
  key: string;
  state: State;
  img: HTMLImageElement;
  container: HTMLElement;
  svg: SVGSVGElement;
  input: HTMLInputElement;
  blobUrl: string | null;
  originalFile: File | null;
}

const MIN_SCALE_MULT = 1;
const MAX_SCALE_MULT = 5;
const ZOOM_SPEED = 0.0015;

const targets: Target[] = [];
const downloadBtn = document.querySelector<HTMLButtonElement>(
  'button[data-action="download"]',
);

const avatar = setup("avatar", ".profile-picture");
const banner = setup("banner", ".profile-banner");
if (avatar) targets.push(avatar);
if (banner) targets.push(banner);

updateDownloadEnabled();

downloadBtn?.addEventListener("click", () => {
  if (downloadBtn.disabled) return;
  download(downloadBtn);
});

function setup(uploadKey: string, containerSelector: string): Target | null {
  const input = document.querySelector<HTMLInputElement>(
    `input[data-upload="${uploadKey}"]`,
  );
  const container = document.querySelector<HTMLElement>(containerSelector);
  const img = container?.querySelector("img") ?? null;
  const svg = container?.closest("svg") ?? null;
  if (!input || !container || !img || !svg) return null;

  const target: Target = {
    key: uploadKey,
    state: { x: 0, y: 0, scale: 1, baseScale: 1 },
    img,
    container,
    svg,
    input,
    blobUrl: null,
    originalFile: null,
  };

  if (img.complete && img.naturalWidth > 0) initialize(target);
  else img.addEventListener("load", () => initialize(target), { once: true });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    if (target.blobUrl) URL.revokeObjectURL(target.blobUrl);
    const url = URL.createObjectURL(file);
    target.blobUrl = url;
    target.originalFile = file;
    img.crossOrigin = "";
    img.onload = () => {
      initialize(target);
      updateDownloadEnabled();
    };
    img.src = url;
  });

  attachInteraction(target);
  return target;
}

function updateDownloadEnabled(): void {
  if (!downloadBtn) return;
  const hasUpload = targets.some((t) => t.originalFile);
  downloadBtn.disabled = !hasUpload;
}

function attachInteraction(t: Target): void {
  let activePointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  t.container.addEventListener("pointerdown", (e) => {
    activePointer = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    t.container.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  t.container.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointer) return;
    const factor = svgUnitsPerScreenPx(t.svg);
    t.state.x += (e.clientX - lastX) * factor;
    t.state.y += (e.clientY - lastY) * factor;
    lastX = e.clientX;
    lastY = e.clientY;
    clampPosition(t);
    apply(t);
  });

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (t.container.hasPointerCapture(e.pointerId))
      t.container.releasePointerCapture(e.pointerId);
  };
  t.container.addEventListener("pointerup", endDrag);
  t.container.addEventListener("pointercancel", endDrag);

  t.container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const oldScale = t.state.scale;
      const ratio = 1 + -e.deltaY * ZOOM_SPEED;
      const min = t.state.baseScale * MIN_SCALE_MULT;
      const max = t.state.baseScale * MAX_SCALE_MULT;
      const newScale = Math.min(max, Math.max(min, oldScale * ratio));
      if (newScale === oldScale) return;

      const cw = t.container.clientWidth;
      const ch = t.container.clientHeight;
      const px = (cw / 2 - t.state.x) / oldScale;
      const py = (ch / 2 - t.state.y) / oldScale;
      t.state.scale = newScale;
      t.state.x = cw / 2 - px * newScale;
      t.state.y = ch / 2 - py * newScale;
      clampPosition(t);
      apply(t);
    },
    { passive: false },
  );
}

function svgUnitsPerScreenPx(svg: SVGSVGElement): number {
  const ctm = svg.getScreenCTM();
  if (!ctm || !ctm.a) return 1;
  return 1 / ctm.a;
}

function initialize(t: Target): void {
  const cw = t.container.clientWidth;
  const ch = t.container.clientHeight;
  const iw = t.img.naturalWidth;
  const ih = t.img.naturalHeight;
  if (!cw || !ch || !iw || !ih) return;
  const baseScale = Math.max(cw / iw, ch / ih);
  t.state.baseScale = baseScale;
  t.state.scale = baseScale;
  t.state.x = (cw - iw * baseScale) / 2;
  t.state.y = (ch - ih * baseScale) / 2;
  apply(t);
}

function clampPosition(t: Target): void {
  const cw = t.container.clientWidth;
  const ch = t.container.clientHeight;
  const w = t.img.naturalWidth * t.state.scale;
  const h = t.img.naturalHeight * t.state.scale;
  if (w >= cw) {
    t.state.x = Math.min(0, Math.max(cw - w, t.state.x));
  } else {
    t.state.x = (cw - w) / 2;
  }
  if (h >= ch) {
    t.state.y = Math.min(0, Math.max(ch - h, t.state.y));
  } else {
    t.state.y = (ch - h) / 2;
  }
}

function apply(t: Target): void {
  t.img.style.transform = `translate(${t.state.x}px, ${t.state.y}px) scale(${t.state.scale})`;
}

async function download(btn: HTMLButtonElement): Promise<void> {
  if (btn.getAttribute("aria-busy") === "true") return;
  btn.setAttribute("aria-busy", "true");
  try {
    const zip = new JSZip();
    let added = 0;
    for (const t of targets) {
      if (!t.originalFile) continue;
      const result = await renderToBlob(t);
      if (!result) continue;
      zip.file(`${t.key}.${result.ext}`, result.blob);
      added++;
    }
    if (added === 0) return;
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "discord-profile.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert(
      "Export failed: " + (err instanceof Error ? err.message : String(err)),
    );
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

async function renderToBlob(
  t: Target,
): Promise<{ blob: Blob; ext: string } | null> {
  if (!t.originalFile) return null;
  if (t.originalFile.type === "image/gif") {
    const blob = await renderGif(t, t.originalFile);
    return { blob, ext: "gif" };
  }
  const blob = await renderStatic(t);
  if (!blob) return null;
  return { blob, ext: "png" };
}

async function renderStatic(t: Target): Promise<Blob | null> {
  const cw = t.container.clientWidth;
  const ch = t.container.clientHeight;
  if (!cw || !ch) return null;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(t.state.x, t.state.y);
  ctx.scale(t.state.scale, t.state.scale);
  ctx.drawImage(t.img, 0, 0);
  ctx.restore();
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}

async function renderGif(t: Target, file: File): Promise<Blob> {
  const buffer = await file.arrayBuffer();
  const parsed = parseGIF(buffer);
  const frames = decompressFrames(parsed, true);
  if (frames.length === 0) throw new Error("GIF has no frames");

  const fullW = parsed.lsd.width;
  const fullH = parsed.lsd.height;

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = fullW;
  srcCanvas.height = fullH;
  const srcCtx = srcCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;

  const cw = t.container.clientWidth;
  const ch = t.container.clientHeight;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = cw;
  outCanvas.height = ch;
  const outCtx = outCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;

  const patchCanvas = document.createElement("canvas");
  const patchCtx = patchCanvas.getContext("2d") as CanvasRenderingContext2D;

  const encoder = GIFEncoder();
  let priorDisposal = 0;
  let priorDims: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null = null;
  let savedState: ImageData | null = null;

  for (const f of frames) {
    if (priorDisposal === 2 && priorDims) {
      srcCtx.clearRect(
        priorDims.left,
        priorDims.top,
        priorDims.width,
        priorDims.height,
      );
    } else if (priorDisposal === 3 && savedState) {
      srcCtx.putImageData(savedState, 0, 0);
    }

    savedState =
      f.disposalType === 3 ? srcCtx.getImageData(0, 0, fullW, fullH) : null;

    patchCanvas.width = f.dims.width;
    patchCanvas.height = f.dims.height;
    const patchData = new ImageData(
      new Uint8ClampedArray(f.patch),
      f.dims.width,
      f.dims.height,
    );
    patchCtx.putImageData(patchData, 0, 0);
    srcCtx.drawImage(patchCanvas, f.dims.left, f.dims.top);

    priorDisposal = f.disposalType;
    priorDims = f.dims;

    outCtx.clearRect(0, 0, cw, ch);
    outCtx.save();
    outCtx.translate(t.state.x, t.state.y);
    outCtx.scale(t.state.scale, t.state.scale);
    outCtx.drawImage(srcCanvas, 0, 0);
    outCtx.restore();

    const rgba = outCtx.getImageData(0, 0, cw, ch).data;
    const palette = quantize(rgba, 256, { format: "rgb444" });
    const index = applyPalette(rgba, palette);
    encoder.writeFrame(index, cw, ch, {
      palette,
      delay: f.delay || 100,
    });
  }

  encoder.finish();
  return new Blob([encoder.bytes()], { type: "image/gif" });
}
