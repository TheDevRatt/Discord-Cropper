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
  outputWidth: number;
  outputHeight: number;
  input: HTMLInputElement;
  zoomInput: HTMLInputElement | null;
  blobUrl: string | null;
  originalFile: File | null;
}

const MIN_SCALE_MULT = 1;
const MAX_SCALE_MULT = 5;
const ZOOM_SPEED = 0.0015;

const targets: Target[] = [];
let selectedTarget: Target | null = null;
const downloadBtn = document.querySelector<HTMLButtonElement>(
  'button[data-action="download"]',
);

const avatar = setup("avatar", ".profile-picture", 512, 512);
const banner = setup("banner", ".profile-banner", 1100, 440);
if (avatar) targets.push(avatar);
if (banner) targets.push(banner);

document.addEventListener("paste", (event) => {
  if (!selectedTarget) return;
  const clipboard = event.clipboardData;
  const file =
    Array.from(clipboard?.files ?? []).find((candidate) =>
      candidate.type.startsWith("image/"),
    ) ??
    Array.from(clipboard?.items ?? [])
      .find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      )
      ?.getAsFile();
  if (!file) return;
  event.preventDefault();
  loadFile(selectedTarget, file);
});

updateDownloadEnabled();

downloadBtn?.addEventListener("click", () => {
  if (downloadBtn.disabled) return;
  download(downloadBtn);
});

function setup(
  uploadKey: string,
  containerSelector: string,
  outputWidth: number,
  outputHeight: number,
): Target | null {
  const input = document.querySelector<HTMLInputElement>(
    `input[data-upload="${uploadKey}"]`,
  );
  const container = document.querySelector<HTMLElement>(containerSelector);
  const img = container?.querySelector("img") ?? null;
  const zoomInput = document.querySelector<HTMLInputElement>(
    `input[data-zoom="${uploadKey}"]`,
  );
  if (!input || !container || !img) return null;

  const target: Target = {
    key: uploadKey,
    state: { x: 0, y: 0, scale: 1, baseScale: 1 },
    img,
    container,
    outputWidth,
    outputHeight,
    input,
    zoomInput,
    blobUrl: null,
    originalFile: null,
  };

  if (img.complete && img.naturalWidth > 0) initialize(target);
  else img.addEventListener("load", () => initialize(target), { once: true });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    loadFile(target, file);
  });

  container.addEventListener("focus", () => {
    selectedTarget = target;
  });

  attachInteraction(target);
  zoomInput?.addEventListener("input", () => {
    setZoomMultiplier(target, Number(zoomInput.value));
  });
  new ResizeObserver(() => apply(target)).observe(container);
  return target;
}

function loadFile(target: Target, file: File): void {
  if (target.blobUrl) URL.revokeObjectURL(target.blobUrl);
  const url = URL.createObjectURL(file);
  target.blobUrl = url;
  target.originalFile = file;
  target.img.crossOrigin = "";
  target.img.onload = () => {
    initialize(target);
    if (target.zoomInput) target.zoomInput.disabled = false;
    updateDownloadEnabled();
  };
  target.img.src = url;
}

function updateDownloadEnabled(): void {
  if (!downloadBtn) return;
  const hasUpload = targets.some((t) => t.originalFile);
  downloadBtn.disabled = !hasUpload;
}

function attachInteraction(t: Target): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch:
    | {
        distance: number;
        scale: number;
        imageX: number;
        imageY: number;
      }
    | null = null;

  const pointerPair = () => Array.from(pointers.values()).slice(0, 2);

  const beginPinch = () => {
    const [first, second] = pointerPair();
    if (!first || !second) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (!distance) return;
    const focus = screenPointToContainer(
      t,
      (first.x + second.x) / 2,
      (first.y + second.y) / 2,
    );
    pinch = {
      distance,
      scale: t.state.scale,
      imageX: (focus.x - t.state.x) / t.state.scale,
      imageY: (focus.y - t.state.y) / t.state.scale,
    };
  };

  t.container.addEventListener("pointerdown", (event) => {
    if (pointers.size >= 2 && !pointers.has(event.pointerId)) return;
    t.container.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    t.container.setPointerCapture(event.pointerId);
    if (pointers.size === 2) beginPinch();
    event.preventDefault();
  });

  t.container.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2) {
      if (!pinch) beginPinch();
      const [first, second] = pointerPair();
      if (!pinch || !first || !second) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const focus = screenPointToContainer(
        t,
        (first.x + second.x) / 2,
        (first.y + second.y) / 2,
      );
      const newScale = clampScale(
        t,
        pinch.scale * (distance / pinch.distance),
      );
      t.state.scale = newScale;
      t.state.x = focus.x - pinch.imageX * newScale;
      t.state.y = focus.y - pinch.imageY * newScale;
      clampPosition(t);
      updateZoomInput(t);
      apply(t);
      event.preventDefault();
      return;
    }

    const factor = outputUnitsPerScreenPx(t);
    t.state.x += (event.clientX - previous.x) * factor.x;
    t.state.y += (event.clientY - previous.y) * factor.y;
    clampPosition(t);
    apply(t);
    event.preventDefault();
  });

  const endPointer = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    pinch = null;
    if (t.container.hasPointerCapture(event.pointerId))
      t.container.releasePointerCapture(event.pointerId);
  };
  t.container.addEventListener("pointerup", endPointer);
  t.container.addEventListener("pointercancel", endPointer);

  t.container.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const ratio = 1 + -event.deltaY * ZOOM_SPEED;
      setScaleAroundCenter(t, t.state.scale * ratio);
    },
    { passive: false },
  );
}

function screenPointToContainer(
  t: Target,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const rect = t.container.getBoundingClientRect();
  return {
    x: ((screenX - rect.left) * t.outputWidth) / rect.width,
    y: ((screenY - rect.top) * t.outputHeight) / rect.height,
  };
}

function clampScale(t: Target, scale: number): number {
  const min = t.state.baseScale * MIN_SCALE_MULT;
  const max = t.state.baseScale * MAX_SCALE_MULT;
  return Math.min(max, Math.max(min, scale));
}

function setScaleAroundCenter(t: Target, requestedScale: number): void {
  const oldScale = t.state.scale;
  const newScale = clampScale(t, requestedScale);
  if (newScale === oldScale) return;
  const focusX = t.outputWidth / 2;
  const focusY = t.outputHeight / 2;
  const imageX = (focusX - t.state.x) / oldScale;
  const imageY = (focusY - t.state.y) / oldScale;
  t.state.scale = newScale;
  t.state.x = focusX - imageX * newScale;
  t.state.y = focusY - imageY * newScale;
  clampPosition(t);
  updateZoomInput(t);
  apply(t);
}

function setZoomMultiplier(t: Target, multiplier: number): void {
  if (!Number.isFinite(multiplier)) return;
  setScaleAroundCenter(t, t.state.baseScale * multiplier);
}

function updateZoomInput(t: Target): void {
  if (!t.zoomInput || !t.state.baseScale) return;
  t.zoomInput.value = String(t.state.scale / t.state.baseScale);
}

function outputUnitsPerScreenPx(t: Target): { x: number; y: number } {
  const rect = t.container.getBoundingClientRect();
  return {
    x: rect.width ? t.outputWidth / rect.width : 1,
    y: rect.height ? t.outputHeight / rect.height : 1,
  };
}

function initialize(t: Target): void {
  const cw = t.outputWidth;
  const ch = t.outputHeight;
  const iw = t.img.naturalWidth;
  const ih = t.img.naturalHeight;
  if (!cw || !ch || !iw || !ih) return;
  const baseScale = Math.max(cw / iw, ch / ih);
  t.state.baseScale = baseScale;
  t.state.scale = baseScale;
  t.state.x = (cw - iw * baseScale) / 2;
  t.state.y = (ch - ih * baseScale) / 2;
  updateZoomInput(t);
  apply(t);
}

function clampPosition(t: Target): void {
  const cw = t.outputWidth;
  const ch = t.outputHeight;
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
  const rect = t.container.getBoundingClientRect();
  if (!rect.width) return;
  const visualScale = rect.width / t.outputWidth;
  t.img.style.transform = `translate(${t.state.x * visualScale}px, ${t.state.y * visualScale}px) scale(${t.state.scale * visualScale})`;
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
  const cw = t.outputWidth;
  const ch = t.outputHeight;
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

  const cw = t.outputWidth;
  const ch = t.outputHeight;
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
