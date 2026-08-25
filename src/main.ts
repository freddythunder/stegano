import "./style.css";
import { clampSynthDim, generateNightOpsCarrier } from "./carrier";
import {
  capacity,
  embed,
  extract,
  fromUtf8,
  hasFrame,
  toUtf8,
  visualizeDelta,
  visualizeLsb,
  type BitsPerChannel,
  type ChannelMask,
  type StegConfig,
} from "./stegano";
import { crypt, cryptRaw, estimateWiredBytes, fetchCiphers, looksLikeOpenssl, requestGptImage } from "./crypt";
import { guessMime, isAudio, packFile, unpackFile, type PackedFile } from "./binfile";
import {
  deleteLibraryPng,
  libraryFileUrl,
  listLibrary,
  saveLibraryPng,
  type LibraryFolder,
  type LibraryItem,
} from "./library";

type View = "carrier" | "stego" | "lsb" | "delta";

const canvas = el<HTMLCanvasElement>("stage");
const maybeCtx = canvas.getContext("2d", { willReadFrequently: true });
if (!maybeCtx) throw new Error("NO RASTER CONTEXT");
const ctx: CanvasRenderingContext2D = maybeCtx;

const state = {
  original: null as ImageData | null,
  stego: null as ImageData | null,
  name: "NO CARRIER",
  view: "carrier" as View,
  bits: 1 as BitsPerChannel,
  channels: { r: true, g: true, b: true } as ChannelMask,
  io: "msg" as "msg" | "gpt" | "bin",
  bin: null as PackedFile | null,
  binUrl: "" as string,
};

const session = `DD-${Math.random().toString(16).slice(2, 6).toUpperCase()}-${String(
  Math.floor(Math.random() * 99),
).padStart(2, "0")}`;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`MISSING #${id}`);
  return node as T;
}

function config(): StegConfig {
  return { bitsPerChannel: state.bits, channels: { ...state.channels } };
}

function setStatus(message: string, kind: "ok" | "warn" | "err" | "" = ""): void {
  const node = el("status");
  node.textContent = `> ${message}`;
  node.className = `status ${kind}`.trim();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function keyValue(): string {
  return el<HTMLInputElement>("key").value;
}

function cipherValue(): string {
  return el<HTMLSelectElement>("cipher").value;
}

function keyed(): boolean {
  return keyValue().length > 0;
}

function payloadBytes(): number {
  if (state.io === "bin" && state.bin) {
    return estimateWiredBytes(state.bin.envelope.length, keyed());
  }
  const n = toUtf8(el<HTMLTextAreaElement>("message").value).length;
  return estimateWiredBytes(n, keyed());
}

function setBusy(busy: boolean): void {
  for (const id of ["embed", "extract", "export", "wipe", "gpt-gen", "bin-save"]) {
    el<HTMLButtonElement>(id).disabled = busy;
  }
}

const MSG_PLACEHOLDER = "enter dead-drop text — embed writes LSBs, extract reads them back";
const GPT_PLACEHOLDER = "describe a carrier — wet cobblestones at night, film grain, wide shot";

function applyIoMode(mode: "msg" | "gpt" | "bin"): void {
  state.io = mode;
  el("payload-panel").setAttribute("data-mode", mode);
  el("payload-title").textContent = mode === "gpt" ? "PROMPT" : mode === "bin" ? "BINARY" : "PAYLOAD";
  el<HTMLTextAreaElement>("message").placeholder = mode === "gpt" ? GPT_PLACEHOLDER : MSG_PLACEHOLDER;
  document.querySelectorAll("#io-mode button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.mode === mode);
  });
  refreshIntel();
}

function refreshPipe(): void {
  const pipe = el("pipe-label");
  const proto = el("proto");
  const filePipe = state.io === "bin";
  if (keyed()) {
    const cipher = cipherValue() || "cipher";
    pipe.textContent = filePipe ? "FILE → ENC → LSB" : "TEXT → ENC → B64 → LSB";
    pipe.classList.add("hot");
    proto.textContent = `FRAME  DDRP · u32be LEN · OPENSSL B64
WALK   L→R, T→B · RGB LSBs, MSB-first bits
PIPE   ${filePipe ? "DDFILE envelope · " : ""}${cipher} · pbkdf2 / 10000 iter · salt
MATCH  bits, channels, cipher, and key must match`;
  } else if (filePipe) {
    pipe.textContent = "FILE → LSB";
    pipe.classList.remove("hot");
    proto.textContent = `FRAME  DDRP · u32be LEN · DDFILE + RAW BYTES
WALK   L→R, T→B · RGB LSBs, MSB-first bits
PIPE   FILE → LSB  (UTF-8 is only for text)
MATCH  extract bits/channels must match embed`;
  } else {
    pipe.textContent = "TEXT → LSB";
    pipe.classList.remove("hot");
    proto.textContent = `FRAME  DDRP · u32be LEN · UTF-8 PAYLOAD
WALK   L→R, T→B · RGB LSBs, MSB-first bits
PIPE   TEXT → LSB  (set a key to encrypt first)
MATCH  extract bits/channels/cipher/key must match embed`;
  }
}

function currentCap() {
  if (!state.original) return null;
  return capacity(state.original.width, state.original.height, config());
}

const viewCam = {
  x: 0,
  y: 0,
  scale: 1,
  userMoved: false,
  drag: null as { id: number; x: number; y: number } | null,
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;

function applyViewCam(): void {
  canvas.style.transform = `translate(${viewCam.x}px, ${viewCam.y}px) scale(${viewCam.scale})`;
  canvas.style.imageRendering = viewCam.scale >= 1.5 ? "pixelated" : "auto";
  const zoom = el("view-zoom");
  zoom.textContent = `${Math.round(viewCam.scale * 100)}%`;
}

function fitView(): void {
  const zone = el("dropzone");
  const zw = zone.clientWidth;
  const zh = zone.clientHeight;
  if (zw < 8 || zh < 8 || canvas.width < 1 || canvas.height < 1) return;
  const pad = 12;
  viewCam.scale = Math.min((zw - pad) / canvas.width, (zh - pad) / canvas.height);
  viewCam.x = (zw - canvas.width * viewCam.scale) / 2;
  viewCam.y = (zh - canvas.height * viewCam.scale) / 2;
  viewCam.userMoved = false;
  applyViewCam();
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  const zone = el("dropzone").getBoundingClientRect();
  const mx = clientX - zone.left;
  const my = clientY - zone.top;
  const ix = (mx - viewCam.x) / viewCam.scale;
  const iy = (my - viewCam.y) / viewCam.scale;
  viewCam.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewCam.scale * factor));
  viewCam.x = mx - ix * viewCam.scale;
  viewCam.y = my - iy * viewCam.scale;
  viewCam.userMoved = true;
  applyViewCam();
}

function zoomCenter(factor: number): void {
  const zone = el("dropzone").getBoundingClientRect();
  zoomAt(zone.left + zone.width / 2, zone.top + zone.height / 2, factor);
}

function activeRaster(): ImageData | null {
  if (state.view === "stego") return state.stego ?? state.original;
  if (state.view === "lsb" && state.original) {
    return visualizeLsb(state.stego ?? state.original, config());
  }
  if (state.view === "delta") {
    if (state.original && state.stego) return visualizeDelta(state.original, state.stego);
    return state.original;
  }
  return state.original;
}

function paint(image: ImageData): void {
  canvas.width = image.width;
  canvas.height = image.height;
  ctx.putImageData(image, 0, 0);
  canvas.classList.add("visible");
  el("dropzone").classList.add("has-image");
  if (!viewCam.userMoved) fitView();
  else applyViewCam();
}

function refreshView(): void {
  const image = activeRaster();
  if (image) paint(image);
}

function refreshIntel(): void {
  refreshPipe();
  refreshSynthTarget();
  const cap = currentCap();
  const used = payloadBytes();
  const capNode = el("cap-bytes");
  const sub = el("cap-sub");
  const fill = el("meter-fill");
  const util = el("util-label");
  const link = el("link-state");
  const wireNote = keyed() ? " WIRE" : "";

  if (!cap || !state.original) {
    capNode.textContent = "—";
    sub.textContent = "awaiting carrier";
    fill.style.width = "0%";
    fill.className = "meter-fill";
    util.textContent = "UTIL 0%";
    el("st-res").textContent = "—";
    el("st-px").textContent = "—";
    el("st-bpp").textContent = "—";
    el("st-bits").textContent = "—";
    el("st-used").textContent = "—";
    link.textContent = "NO CARRIER";
    link.className = "link-state";
    el("payload-meta").textContent = ioMeta(used, wireNote);
    return;
  }

  const ratio = cap.payloadBytes === 0 ? 1 : used / cap.payloadBytes;
  const pct = Math.min(100, ratio * 100);
  capNode.textContent = formatBytes(cap.payloadBytes);
  sub.textContent = `${cap.width}×${cap.height} · ${cap.channelsUsed} ch · ${cap.bitsPerChannel} LSB · ~${cap.payloadBytes.toLocaleString()} UTF-8 bytes`;
  fill.style.width = `${pct}%`;
  fill.className = "meter-fill";
  if (ratio >= 1) fill.classList.add("hot");
  else if (ratio >= 0.8) fill.classList.add("warn");
  util.textContent = `UTIL ${Math.min(999, Math.round(pct))}%  ·  ${used.toLocaleString()} / ${cap.payloadBytes.toLocaleString()} B`;

  el("st-res").textContent = `${cap.width} × ${cap.height}`;
  el("st-px").textContent = cap.pixels.toLocaleString();
  el("st-bpp").textContent = String(cap.bitsPerPixel);
  el("st-bits").textContent = cap.totalBits.toLocaleString();
  el("st-used").textContent = `${used.toLocaleString()} B${wireNote}`;
  el("payload-meta").textContent = ioMeta(used, wireNote);

  if (state.bin) refreshBinInfo();

  const framed = state.original ? hasFrame(state.stego ?? state.original, config()) : false;
  if (framed) {
    link.textContent = "FRAME PRESENT";
    link.className = "link-state frame";
  } else {
    link.textContent = "CARRIER LOCKED";
    link.className = "link-state live";
  }

  const note = el("artifact-note");
  if (state.bits === 1) {
    note.textContent = "1 LSB ≈ invisible on PNG";
    note.className = "note";
  } else {
    note.textContent = `${state.bits} LSBs will show banding — check LSB / DELTA`;
    note.className = "note warn";
  }
}

async function revealPayload(bytes: Uint8Array, prefix: string): Promise<void> {
  const box = el<HTMLTextAreaElement>("message");
  const direct = unpackFile(bytes);
  if (direct) {
    armBinary(direct);
    applyIoMode("bin");
    setStatus(`${prefix} · FILE ${direct.name} · ${formatBytes(direct.bytes.length)} RAW`, "ok");
    return;
  }

  if (keyed()) {
    try {
      const plain = await cryptRaw("decrypt", cipherValue(), keyValue(), bytes);
      const packed = unpackFile(plain);
      if (packed) {
        armBinary(packed);
        applyIoMode("bin");
        setStatus(`${prefix} · FILE ${packed.name} · ${formatBytes(packed.bytes.length)} RAW · DECRYPTED`, "ok");
        return;
      }
      const decoded = fromUtf8(plain);
      clearBin();
      applyIoMode("msg");
      box.value = decoded.text;
      refreshIntel();
      setStatus(
        decoded.binary
          ? `${prefix} · DECRYPTED BINARY ${plain.length} B (HEX)`
          : `${prefix} · DECRYPTED WITH ${cipherValue()}`,
        "ok",
      );
      return;
    } catch (error) {
      const decoded = fromUtf8(bytes);
      applyIoMode("msg");
      box.value = decoded.text;
      refreshIntel();
      const detail = error instanceof Error ? error.message : "DECRYPT FAILED";
      setStatus(`${prefix} · CIPHERTEXT HELD · ${detail}`, "err");
      return;
    }
  }

  const decoded = fromUtf8(bytes);
  clearBin();
  applyIoMode(state.io === "gpt" ? "gpt" : "msg");
  box.value = decoded.text;
  refreshIntel();
  if (looksLikeOpenssl(decoded.text)) {
    setStatus(`${prefix} · OPENSSL BLOB — ENTER KEY AND EXTRACT`, "warn");
    return;
  }
  setStatus(
    decoded.binary ? `${prefix} · BINARY FRAME ${bytes.length} B (HEX)` : `${prefix} · ${bytes.length} B`,
    "ok",
  );
}

type PersistTarget = LibraryFolder | false;
type ShelfResult = { name: string; skipped: boolean };

function imageDataToBlob(image: ImageData): Promise<Blob> {
  const off = document.createElement("canvas");
  off.width = image.width;
  off.height = image.height;
  const offCtx = off.getContext("2d");
  if (!offCtx) return Promise.reject(new Error("NO OFFSCREEN CONTEXT"));
  offCtx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => {
    off.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG ENCODE FAILED"))), "image/png");
  });
}

async function persistPng(folder: LibraryFolder, name: string, data: ImageData | Blob): Promise<ShelfResult | null> {
  try {
    const blob = data instanceof Blob ? data : await imageDataToBlob(data);
    return await saveLibraryPng(folder, name, blob);
  } catch (error) {
    console.warn(error);
    return null;
  }
}

function shelfNote(folder: LibraryFolder, saved: ShelfResult | null, miss = ""): string {
  if (!saved) return miss;
  return saved.skipped ? ` · ON REEL ${folder}/${saved.name}` : ` · SHELVED ${folder}/${saved.name}`;
}

async function ingest(image: ImageData, name: string, persist: PersistTarget = "source"): Promise<void> {
  state.original = image;
  state.stego = null;
  state.name = name;
  state.view = "carrier";
  viewCam.userMoved = false;
  document.querySelectorAll(".view-switch button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.view === "carrier");
  });
  refreshView();
  refreshIntel();

  let shelved = "";
  if (persist) {
    const saved = await persistPng(persist, name, image);
    shelved = shelfNote(persist, saved);
  }

  try {
    const bytes = extract(image, config());
    await revealPayload(bytes, `CARRIER INGESTED · ${name}${shelved}`);
  } catch {
    setStatus(`CARRIER INGESTED · ${name} · CLEAN — NO DDRP FRAME${shelved}`, "ok");
  }
  refreshIntel();
}

function imageFromBitmap(source: CanvasImageSource, width: number, height: number): ImageData {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const offCtx = off.getContext("2d");
  if (!offCtx) throw new Error("NO OFFSCREEN CONTEXT");
  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = "high";
  offCtx.drawImage(source, 0, 0, width, height);
  return offCtx.getImageData(0, 0, width, height);
}

async function loadFile(file: File): Promise<void> {
  const bitmap = await createImageBitmap(file);
  await ingest(imageFromBitmap(bitmap, bitmap.width, bitmap.height), file.name);
}

async function loadBlob(blob: Blob, name: string): Promise<void> {
  const bitmap = await createImageBitmap(blob);
  await ingest(imageFromBitmap(bitmap, bitmap.width, bitmap.height), name);
}

async function loadUrl(url: string): Promise<void> {
  setStatus(`PULLING ${url} …`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") && blob.type !== "application/octet-stream" && blob.type !== "") {
      throw new Error(`NOT AN IMAGE (${blob.type || "unknown"})`);
    }
    await loadBlob(blob, url.split("/").pop() || "remote.png");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "FAIL";
    setStatus(`REMOTE READ BLOCKED · ${detail} · save locally and ingest`, "err");
  }
}

async function onEmbed(): Promise<void> {
  if (!state.original) {
    setStatus("NO CARRIER", "err");
    return;
  }
  try {
    if (state.io === "bin" && !state.bin) {
      setStatus("NO BINARY ARMED", "err");
      return;
    }
    setBusy(true);
    let payload: Uint8Array;
    if (state.io === "bin" && state.bin) {
      payload = state.bin.envelope;
      if (keyed()) {
        setStatus(`ENCRYPTING ${cipherValue()} …`);
        payload = await cryptRaw("encrypt", cipherValue(), keyValue(), payload);
      }
    } else {
      let wire = el<HTMLTextAreaElement>("message").value;
      if (keyed()) {
        setStatus(`ENCRYPTING ${cipherValue()} …`);
        wire = await crypt("encrypt", cipherValue(), keyValue(), wire);
      }
      payload = toUtf8(wire);
    }
    state.stego = embed(state.original, payload, config());
    state.view = "stego";
    document.querySelectorAll(".view-switch button").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.view === "stego");
    });
    refreshView();
    refreshIntel();
    const pipe = keyed() ? ` · ${cipherValue()}` : state.io === "bin" ? " · DDFILE RAW" : "";
    const stem = state.name.replace(/\.[^.]+$/, "") || "deaddrop";
    const saved = state.stego ? await persistPng("output", `${stem}.stego.png`, state.stego) : null;
    setStatus(
      `EMBED COMPLETE · ${payload.length} B INTO ${state.name}${pipe}${shelfNote("output", saved, " · EXPORT PNG TO KEEP IT")}`,
      "ok",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "EMBED FAILED", "err");
  } finally {
    setBusy(false);
  }
}

async function onExtract(): Promise<void> {
  const source = state.stego ?? state.original;
  if (!source) {
    setStatus("NO CARRIER", "err");
    return;
  }
  try {
    setBusy(true);
    const bytes = extract(source, config());
    await revealPayload(bytes, `EXTRACTED ${bytes.length} B`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "EXTRACT FAILED", "err");
  } finally {
    setBusy(false);
  }
}

function ioMeta(used: number, wireNote: string): string {
  if (state.io === "gpt") {
    return `${el<HTMLTextAreaElement>("message").value.length.toLocaleString()} CH`;
  }
  if (state.io === "bin" && state.bin) {
    return `${formatBytes(used)}${wireNote}`;
  }
  return `${used.toLocaleString()} B${wireNote}`;
}

function blobFromBytes(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: mime });
}

function clearBin(): void {
  if (state.binUrl) URL.revokeObjectURL(state.binUrl);
  state.bin = null;
  state.binUrl = "";
  const audio = el<HTMLAudioElement>("bin-audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.hidden = true;
  el("bin-info").textContent = "NO FILE ARMED — AUDIO, PDF, ZIP…";
}

function refreshBinInfo(): void {
  if (!state.bin) {
    el("bin-info").textContent = "NO FILE ARMED — AUDIO, PDF, ZIP…";
    return;
  }
  const cap = currentCap();
  const wire = estimateWiredBytes(state.bin.envelope.length, keyed());
  const over = Boolean(cap && wire > cap.payloadBytes);
  el("bin-info").textContent = `${state.bin.name}  ·  RAW ${formatBytes(state.bin.bytes.length)}  →  ${formatBytes(wire)} IN IMAGE${over ? "  OVER SLOT" : ""}`;
}

function armBinary(packed: PackedFile): void {
  if (state.binUrl) URL.revokeObjectURL(state.binUrl);
  state.bin = packed;
  state.binUrl = URL.createObjectURL(blobFromBytes(packed.bytes, packed.mime));
  refreshBinInfo();
  const audio = el<HTMLAudioElement>("bin-audio");
  if (isAudio(packed.mime)) {
    audio.src = state.binUrl;
    audio.hidden = false;
  } else {
    audio.pause();
    audio.removeAttribute("src");
    audio.hidden = true;
  }
}

async function loadBinaryFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  armBinary(packFile(file.name, guessMime(file.name, file.type), bytes));
  applyIoMode("bin");
  const cap = currentCap();
  const used = payloadBytes();
  if (cap && used > cap.payloadBytes) {
    setStatus(`FILE ARMED · OVER CAPACITY · ${formatBytes(used)} > ${formatBytes(cap.payloadBytes)}`, "err");
  } else {
    setStatus(`FILE ARMED · ${file.name} · ${formatBytes(bytes.length)} RAW`, "ok");
  }
}

function saveBinary(): void {
  if (!state.bin) {
    setStatus("NO BINARY ARMED", "err");
    return;
  }
  const a = document.createElement("a");
  a.href = state.binUrl || URL.createObjectURL(blobFromBytes(state.bin.bytes, state.bin.mime));
  a.download = state.bin.name;
  a.click();
  setStatus(`SAVED ${state.bin.name} · ${formatBytes(state.bin.bytes.length)}`, "ok");
}

function b64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function onGptGen(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>("message").value.trim();
  if (!prompt) {
    setStatus("PROMPT EMPTY", "err");
    return;
  }
  const size = peekSynthSize() ?? { width: 1024, height: 1024 };
  try {
    setBusy(true);
    setStatus(`GPT PAINTING ${size.width}×${size.height} CARRIER …`);
    const result = await requestGptImage(prompt, size.width, size.height);
    const blob = b64ToBlob(result.b64, result.mime);
    const targetKey = `${size.width}x${size.height}`;
    const bitmap = await createImageBitmap(blob);
    const raster = imageFromBitmap(bitmap, size.width, size.height);
    bitmap.close();
    await ingest(raster, `GPT-${targetKey}.png`, "source");
    setStatus(
      `GPT CARRIER LOCKED · ${result.model} ${result.apiSize} → ${size.width}×${size.height} · SWITCH TO MSG TO EMBED`,
      "ok",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "GPT IMAGE FAILED", "err");
  } finally {
    setBusy(false);
  }
}

async function onExport(): Promise<void> {
  const source = state.stego ?? state.original;
  if (!source) {
    setStatus("NO CARRIER", "err");
    return;
  }
  try {
    const blob = await imageDataToBlob(source);
    const stem = state.name.replace(/\.[^.]+$/, "") || "deaddrop";
    const filename = `${stem}.stego.png`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`EXPORTED ${filename} · ${formatBytes(blob.size)}`, "ok");
  } catch {
    setStatus("EXPORT FAILED", "err");
  }
}

function onWipe(): void {
  if (!state.original) return;
  state.stego = null;
  state.view = "carrier";
  document.querySelectorAll(".view-switch button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.view === "carrier");
  });
  el<HTMLTextAreaElement>("message").value = "";
  clearBin();
  refreshView();
  refreshIntel();
  setStatus("BUFFER WIPED · CARRIER RESTORED", "warn");
}

function openInfo(): void {
  const modal = el("info-modal");
  modal.hidden = false;
  el("info-close").focus();
}

function closeInfo(): void {
  el("info-modal").hidden = true;
}

let libFolder: LibraryFolder = "source";

function closeLibrary(): void {
  el("lib-modal").hidden = true;
}

function closeModals(): void {
  closeInfo();
  closeLibrary();
}

async function renderLibrary(): Promise<void> {
  const grid = el("lib-grid");
  const count = el("lib-count");
  document.querySelectorAll(".lib-tabs button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.lib === libFolder);
  });
  count.textContent = "LOADING";
  grid.replaceChildren();
  try {
    const items = await listLibrary(libFolder);
    count.textContent = `${items.length} PNG`;
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "lib-empty";
      empty.textContent = `NO FILM IN images/${libFolder}/`;
      grid.append(empty);
      return;
    }
    for (const item of items) grid.append(libraryCard(item));
  } catch (error) {
    count.textContent = "OFFLINE";
    const empty = document.createElement("p");
    empty.className = "lib-empty";
    empty.textContent = error instanceof Error ? error.message : "LIBRARY OFFLINE";
    grid.append(empty);
  }
}

function libraryCard(item: LibraryItem): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "lib-item";
  card.title = `LOAD ${item.name}`;

  const img = document.createElement("img");
  img.alt = item.name;
  img.src = libraryFileUrl(libFolder, item.name);

  const del = document.createElement("span");
  del.className = "lib-del";
  del.textContent = "DEL";
  del.title = `DELETE ${item.name}`;

  const cap = document.createElement("div");
  cap.className = "cap";
  const nm = document.createElement("div");
  nm.className = "nm";
  nm.textContent = item.name;
  const sz = document.createElement("div");
  sz.className = "sz";
  sz.textContent = formatBytes(item.bytes);
  cap.append(nm, sz);

  card.append(img, del, cap);
  card.addEventListener("click", () => void loadLibraryItem(item.name));
  del.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void removeLibraryItem(item.name);
  });
  return card;
}

async function openLibrary(): Promise<void> {
  el("lib-modal").hidden = false;
  el("lib-close").focus();
  await renderLibrary();
}

async function loadLibraryItem(name: string): Promise<void> {
  try {
    setStatus(`LOADING ${libFolder}/${name} …`);
    const response = await fetch(libraryFileUrl(libFolder, name));
    if (!response.ok) throw new Error("READ FAILED");
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const raster = imageFromBitmap(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    closeLibrary();
    await ingest(raster, name, false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "LIBRARY LOAD FAILED", "err");
  }
}

async function removeLibraryItem(name: string): Promise<void> {
  try {
    await deleteLibraryPng(libFolder, name);
    await renderLibrary();
    setStatus(`PULLED ${libFolder}/${name} FROM THE REEL`, "warn");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "DELETE FAILED", "err");
  }
}

async function loadCipherSelect(): Promise<void> {
  const select = el<HTMLSelectElement>("cipher");
  try {
    const catalog = await fetchCiphers();
    select.replaceChildren();
    for (const group of catalog.groups) {
      const og = document.createElement("optgroup");
      og.label = `${group.family} · ${group.ciphers.length}`;
      for (const cipher of group.ciphers) {
        const opt = document.createElement("option");
        opt.value = cipher.id;
        opt.textContent = cipher.alias ? `${cipher.id}  (alias)` : cipher.id;
        og.append(opt);
      }
      select.append(og);
    }
    select.value = "aes-256-cbc";
    if (!select.value && select.options.length > 0) {
      select.selectedIndex = 0;
    }
    refreshPipe();
  } catch {
    select.replaceChildren();
    const fallback = document.createElement("option");
    fallback.value = "aes-256-cbc";
    fallback.textContent = "aes-256-cbc";
    select.append(fallback);
    setStatus("OPENSSL CATALOG OFFLINE — CRYPTO MAY FAIL", "warn");
  }
}

function peekSynthSize(): { width: number; height: number } | null {
  const width = Number(el<HTMLInputElement>("synth-w").value);
  const height = Number(el<HTMLInputElement>("synth-h").value);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width: clampSynthDim(width), height: clampSynthDim(height) };
}

function matchPreset(): void {
  const size = peekSynthSize();
  const select = el<HTMLSelectElement>("synth-preset");
  if (!size) {
    select.value = "custom";
    return;
  }
  const key = `${size.width}x${size.height}`;
  const exists = [...select.options].some((opt) => opt.value === key);
  select.value = exists ? key : "custom";
}

function refreshSynthTarget(): void {
  const node = el("synth-target");
  const size = peekSynthSize();
  if (!size) {
    node.textContent = "W×H 16–4096";
    return;
  }
  const cap = capacity(size.width, size.height, config());
  node.textContent = `TARGET ${formatBytes(cap.payloadBytes)} @ ${size.width}×${size.height}`;
}

function runSynth(persist: PersistTarget = "source"): void {
  const size = peekSynthSize();
  if (!size) {
    setStatus("SYNTH SIZE MUST BE 16–4096", "err");
    return;
  }
  el<HTMLInputElement>("synth-w").value = String(size.width);
  el<HTMLInputElement>("synth-h").value = String(size.height);
  matchPreset();
  const megapixels = (size.width * size.height) / 1_000_000;
  setStatus(
    `SYNTHESIZING ${size.width}×${size.height}${megapixels >= 1 ? ` · ${megapixels.toFixed(1)} MP — may hitch` : ""} …`,
  );
  window.setTimeout(() => {
    void ingest(
      generateNightOpsCarrier(size.width, size.height),
      `SAT-NVG-SYNTH-${size.width}x${size.height}.png`,
      persist,
    ).then(() => {
      const cap = currentCap();
      if (cap) {
        setStatus(
          `SYNTH LOCKED · ${size.width}×${size.height} · SLOT ${formatBytes(cap.payloadBytes)}`,
          "ok",
        );
      }
    });
  }, 30);
}

function snapCurrentSize(): void {
  if (!state.original) {
    setStatus("NO CARRIER", "err");
    return;
  }
  el<HTMLInputElement>("synth-w").value = String(state.original.width);
  el<HTMLInputElement>("synth-h").value = String(state.original.height);
  matchPreset();
  refreshSynthTarget();
  setStatus(`SNAPPED W×H TO ${state.original.width}×${state.original.height}`, "ok");
}

async function resizeCurrent(): Promise<void> {
  if (!state.original) {
    setStatus("NO CARRIER", "err");
    return;
  }
  const size = peekSynthSize();
  if (!size) {
    setStatus("SIZE MUST BE 16–4096", "err");
    return;
  }
  if (size.width === state.original.width && size.height === state.original.height) {
    setStatus("ALREADY AT THAT RESOLUTION", "warn");
    return;
  }
  const fromW = state.original.width;
  const fromH = state.original.height;
  const bitmap = await createImageBitmap(state.original);
  const next = imageFromBitmap(bitmap, size.width, size.height);
  bitmap.close();
  const stem = state.name.replace(/\.[^.]+$/, "") || "carrier";
  viewCam.userMoved = false;
  await ingest(next, `${stem}-${size.width}x${size.height}.png`);
  setStatus(
    `RESAMPLED ${fromW}×${fromH} → ${size.width}×${size.height} · LSB PAYLOAD DOES NOT SURVIVE SCALE`,
    "warn",
  );
}

function tickClock(): void {
  const now = new Date();
  el("clock").textContent = now.toISOString().slice(11, 19) + "Z";
}

function wireUi(): void {
  el("session").textContent = `SESSION ${session}`;
  tickClock();
  window.setInterval(tickClock, 1000);

  el<HTMLInputElement>("file").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) await loadFile(file);
  });

  el<HTMLFormElement>("url-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = el<HTMLInputElement>("url").value.trim();
    if (url) await loadUrl(url);
  });

  el("gen").addEventListener("click", () => runSynth());
  el("snap-size").addEventListener("click", snapCurrentSize);
  el("resize").addEventListener("click", () => void resizeCurrent());
  el<HTMLSelectElement>("synth-preset").addEventListener("change", () => {
    const value = el<HTMLSelectElement>("synth-preset").value;
    if (value === "custom") return;
    const [width, height] = value.split("x");
    el<HTMLInputElement>("synth-w").value = width;
    el<HTMLInputElement>("synth-h").value = height;
    refreshSynthTarget();
    runSynth();
  });
  const onDimInput = () => {
    matchPreset();
    refreshSynthTarget();
  };
  el("synth-w").addEventListener("input", onDimInput);
  el("synth-h").addEventListener("input", onDimInput);
  for (const id of ["synth-w", "synth-h"]) {
    el(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSynth();
      }
    });
  }

  el("embed").addEventListener("click", () => void onEmbed());
  el("extract").addEventListener("click", () => void onExtract());
  el("gpt-gen").addEventListener("click", () => void onGptGen());
  el("bin-save").addEventListener("click", saveBinary);
  el("export").addEventListener("click", () => void onExport());
  el("wipe").addEventListener("click", onWipe);

  el<HTMLInputElement>("bin-file").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) await loadBinaryFile(file);
  });
  const binPane = el("bin-pane");
  binPane.addEventListener("dragover", (event) => {
    event.preventDefault();
    binPane.classList.add("hot");
  });
  binPane.addEventListener("dragleave", () => binPane.classList.remove("hot"));
  binPane.addEventListener("drop", async (event) => {
    event.preventDefault();
    binPane.classList.remove("hot");
    const file = event.dataTransfer?.files?.[0];
    if (file) await loadBinaryFile(file);
  });

  document.querySelectorAll("#io-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyIoMode(((btn as HTMLElement).dataset.mode as "msg" | "gpt" | "bin") ?? "msg");
    });
  });

  const onCryptoChange = () => refreshIntel();
  el("key").addEventListener("input", onCryptoChange);
  el("cipher").addEventListener("change", onCryptoChange);

  el<HTMLTextAreaElement>("message").addEventListener("input", () => {
    refreshIntel();
    if (state.io !== "msg") return;
    const cap = currentCap();
    if (cap && payloadBytes() > cap.payloadBytes) {
      setStatus(`OVER CAPACITY · ${payloadBytes()} > ${cap.payloadBytes} B`, "err");
    }
  });

  document.querySelectorAll(".view-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = ((btn as HTMLElement).dataset.view as View) ?? "carrier";
      document.querySelectorAll(".view-switch button").forEach((other) => other.classList.remove("active"));
      btn.classList.add("active");
      if (state.view === "delta" && !state.stego) {
        setStatus("DELTA NEEDS AN EMBED FIRST", "warn");
      }
      refreshView();
    });
  });

  document.querySelectorAll("#bits-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.bits = Number((btn as HTMLElement).dataset.bits) as BitsPerChannel;
      document.querySelectorAll("#bits-seg button").forEach((other) => other.classList.remove("active"));
      btn.classList.add("active");
      refreshIntel();
      refreshView();
    });
  });

  document.querySelectorAll("#ch-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ch = (btn as HTMLElement).dataset.ch as keyof ChannelMask;
      state.channels[ch] = !state.channels[ch];
      btn.classList.toggle("active", state.channels[ch]);
      if (!state.channels.r && !state.channels.g && !state.channels.b) {
        state.channels[ch] = true;
        btn.classList.add("active");
        setStatus("AT LEAST ONE CHANNEL MUST STAY ARMED", "warn");
      }
      refreshIntel();
      refreshView();
    });
  });

  const zone = el("dropzone");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("hot");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("hot"));
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("hot");
    viewCam.drag = null;
    zone.classList.remove("panning");
    const file = event.dataTransfer?.files?.[0];
    if (file) await loadFile(file);
  });

  zone.addEventListener(
    "wheel",
    (event) => {
      if (!state.original) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(event.clientX, event.clientY, factor);
    },
    { passive: false },
  );

  zone.addEventListener("pointerdown", (event) => {
    if (!state.original) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    viewCam.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    zone.setPointerCapture(event.pointerId);
    zone.classList.add("panning");
  });

  zone.addEventListener("pointermove", (event) => {
    if (!viewCam.drag || viewCam.drag.id !== event.pointerId) return;
    viewCam.x += event.clientX - viewCam.drag.x;
    viewCam.y += event.clientY - viewCam.drag.y;
    viewCam.drag.x = event.clientX;
    viewCam.drag.y = event.clientY;
    viewCam.userMoved = true;
    applyViewCam();
  });

  const endPan = (event: PointerEvent) => {
    if (!viewCam.drag || viewCam.drag.id !== event.pointerId) return;
    viewCam.drag = null;
    zone.classList.remove("panning");
  };
  zone.addEventListener("pointerup", endPan);
  zone.addEventListener("pointercancel", endPan);

  zone.addEventListener("dblclick", (event) => {
    if (!state.original) return;
    event.preventDefault();
    fitView();
  });

  el("view-fit").addEventListener("click", fitView);
  el("view-in").addEventListener("click", () => {
    if (state.original) zoomCenter(1.2);
  });
  el("view-out").addEventListener("click", () => {
    if (state.original) zoomCenter(1 / 1.2);
  });

  new ResizeObserver(() => {
    if (state.original && !viewCam.userMoved) fitView();
  }).observe(zone);

  window.addEventListener("paste", async (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (file) await loadFile(file);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModals();
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    if (!typing && state.original) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomCenter(1.15);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomCenter(1 / 1.15);
      } else if (event.key === "0" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        fitView();
      }
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      if (state.io === "gpt") void onGptGen();
      else void onEmbed();
    } else if (event.key.toLowerCase() === "enter" && event.shiftKey) {
      event.preventDefault();
      void onExtract();
    }
  });

  el("info-open").addEventListener("click", openInfo);
  el("info-close").addEventListener("click", closeInfo);
  el("info-modal").addEventListener("click", (event) => {
    if ((event.target as HTMLElement).dataset.close) closeInfo();
  });
  el("lib-open").addEventListener("click", () => void openLibrary());
  el("lib-close").addEventListener("click", closeLibrary);
  el("lib-modal").addEventListener("click", (event) => {
    if ((event.target as HTMLElement).dataset.close) closeLibrary();
  });
  document.querySelectorAll(".lib-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      libFolder = ((btn as HTMLElement).dataset.lib as LibraryFolder) ?? "source";
      void renderLibrary();
    });
  });

  void loadCipherSelect();
  setStatus("STANDBY // SYNTHESIZING DEFAULT CARRIER …");
  refreshIntel();
  window.setTimeout(() => runSynth(false), 30);
}

wireUi();
