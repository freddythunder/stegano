import "./style.css";
import { clampSynthDim, generateNightOpsCarrier } from "./carrier";
import {
  capacity,
  embed,
  extract,
  fromUtf8,
  hasFrame,
  stripFrame,
  toUtf8,
  visualizeDelta,
  visualizeLsb,
  type BitsPerChannel,
  type ChannelMask,
  type StegConfig,
} from "./stegano";
import { cryptRaw, estimateWiredBytes, fetchCiphers, looksLikeOpensslBytes, requestGptImage } from "./crypt";
import {
  bytesToBase64,
  guessMime,
  isAudio,
  isImage,
  isPdf,
  isVideo,
  joinEnvelopes,
  packFile,
  recoverFiles,
  sniffMime,
  type PackedFile,
} from "./binfile";
import { decodePng, encodePng, isPngBytes, pngToImageData } from "./png";
import {
  deleteLibraryPng,
  libraryFileUrl,
  listLibrary,
  saveLibraryPng,
  type LibraryFolder,
  type LibraryItem,
} from "./library";

type View = "carrier" | "stego" | "lsb" | "delta";

type ArmedBin = {
  packed: PackedFile;
  url: string;
};

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
  io: "msg" as "msg" | "bin",
  bins: [] as ArmedBin[],
  binFromExtract: false,
  heldFrame: null as Uint8Array | null,
  lab: "embed" as "embed" | "extract",
};

let uiBusy = false;
let pendingCipher = "";
const CIPHER_STORE = "dd-cipher";
const LAB_STORE = "dd-lab";
const LAYOUT_STORE = "dd-layout";
const COL_MIN: Record<"carrier" | "intel" | "payload", number> = {
  carrier: 240,
  intel: 200,
  payload: 260,
};

function layoutNarrow(): boolean {
  return window.matchMedia("(max-width: 980px)").matches;
}

function colPanel(key: "carrier" | "intel" | "payload"): HTMLElement {
  const node = el("workspace").querySelector(`[data-col="${key}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`MISSING COLUMN ${key}`);
  return node;
}

function applyColPercents(percents: [number, number, number]): void {
  const keys = ["carrier", "intel", "payload"] as const;
  keys.forEach((key, i) => {
    colPanel(key).style.flex = `${percents[i]} 1 0%`;
  });
}

function saveColLayout(): void {
  if (layoutNarrow()) return;
  const widths = (["carrier", "intel", "payload"] as const).map((key) => colPanel(key).getBoundingClientRect().width);
  const total = widths.reduce((a, b) => a + b, 0);
  if (total < 1) return;
  const percents = widths.map((w) => Math.round((w / total) * 1000) / 10) as [number, number, number];
  try {
    localStorage.setItem(LAYOUT_STORE, JSON.stringify(percents));
  } catch {
    /* ignore quota */
  }
}

function restoreColLayout(): void {
  try {
    const raw = localStorage.getItem(LAYOUT_STORE);
    if (!raw) return;
    const percents = JSON.parse(raw) as unknown;
    if (!Array.isArray(percents) || percents.length !== 3) return;
    if (!percents.every((n) => typeof n === "number" && n > 5 && n < 90)) return;
    applyColPercents(percents as [number, number, number]);
  } catch {
    /* keep CSS defaults */
  }
}

function wireSplitters(): void {
  restoreColLayout();
  window.matchMedia("(max-width: 980px)").addEventListener("change", (event) => {
    if (event.matches) {
      (["carrier", "intel", "payload"] as const).forEach((key) => {
        colPanel(key).style.removeProperty("flex");
      });
      return;
    }
    restoreColLayout();
  });
  document.querySelectorAll(".splitter").forEach((node) => {
    const split = node as HTMLElement;
    split.addEventListener("dblclick", () => {
      if (layoutNarrow()) return;
      try {
        localStorage.removeItem(LAYOUT_STORE);
      } catch {
        /* ignore */
      }
      (["carrier", "intel", "payload"] as const).forEach((key) => {
        colPanel(key).style.removeProperty("flex");
      });
    });
    split.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if (layoutNarrow()) return;
      event.preventDefault();
      const index = Number(split.dataset.split);
      const pair: Array<"carrier" | "intel" | "payload"> =
        index === 0 ? ["carrier", "intel"] : ["intel", "payload"];
      const keys = ["carrier", "intel", "payload"] as const;
      const start = Object.fromEntries(
        keys.map((key) => [key, colPanel(key).getBoundingClientRect().width]),
      ) as Record<(typeof keys)[number], number>;
      keys.forEach((key) => {
        colPanel(key).style.flex = `0 0 ${start[key]}px`;
      });
      const left = colPanel(pair[0]);
      const right = colPanel(pair[1]);
      const startX = event.clientX;
      const startLeft = start[pair[0]];
      const startRight = start[pair[1]];
      split.classList.add("dragging");
      document.body.classList.add("col-resizing");
      try {
        split.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointer */
      }

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== event.pointerId) return;
        const dx = move.clientX - startX;
        let nextLeft = startLeft + dx;
        let nextRight = startRight - dx;
        const minLeft = COL_MIN[pair[0]];
        const minRight = COL_MIN[pair[1]];
        if (nextLeft < minLeft) {
          nextRight -= minLeft - nextLeft;
          nextLeft = minLeft;
        }
        if (nextRight < minRight) {
          nextLeft -= minRight - nextRight;
          nextRight = minRight;
        }
        if (nextLeft < minLeft || nextRight < minRight) return;
        left.style.flex = `0 0 ${nextLeft}px`;
        right.style.flex = `0 0 ${nextRight}px`;
      };

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== event.pointerId) return;
        try {
          split.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        split.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        split.removeEventListener("pointermove", onMove);
        split.removeEventListener("pointerup", onUp);
        split.removeEventListener("pointercancel", onUp);
        saveColLayout();
        restoreColLayout();
      };

      split.addEventListener("pointermove", onMove);
      split.addEventListener("pointerup", onUp);
      split.addEventListener("pointercancel", onUp);
    });
  });
}

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

function applyStoredCipher(id: string | undefined): void {
  if (!id) return;
  const select = el<HTMLSelectElement>("cipher");
  const match = [...select.options].some((opt) => opt.value === id);
  if (match) {
    select.value = id;
    pendingCipher = "";
    try {
      localStorage.setItem(CIPHER_STORE, id);
    } catch {
      /* ignore quota */
    }
    refreshPipe();
    return;
  }
  pendingCipher = id;
}

function rememberCipher(): void {
  const id = cipherValue();
  if (!id) return;
  try {
    localStorage.setItem(CIPHER_STORE, id);
  } catch {
    /* ignore quota */
  }
}

function keyed(): boolean {
  return keyValue().length > 0;
}

function frameLooksKeyed(bytes: Uint8Array): boolean {
  return looksLikeOpensslBytes(bytes);
}

function payloadBytes(): number {
  if (state.io === "bin" && state.bins.length) {
    const raw = state.bins.reduce((sum, item) => sum + item.packed.envelope.length, 0);
    return estimateWiredBytes(raw, keyed());
  }
  const text = el<HTMLTextAreaElement>("message").value;
  if (!text && state.heldFrame) return state.heldFrame.length;
  const n = toUtf8(text).length;
  return estimateWiredBytes(n, keyed());
}

function overflowReason(): string | null {
  const cap = currentCap();
  if (!cap) return null;
  const used = payloadBytes();
  if (used <= cap.payloadBytes) return null;
  return `PAYLOAD ${used.toLocaleString()} B EXCEEDS CAPACITY ${cap.payloadBytes.toLocaleString()} B — RAISE BITS/CHANNEL, OPEN MORE CHANNELS, OR USE A LARGER CARRIER`;
}

function syncExportButton(): void {
  const wrap = el("export-wrap");
  const btn = el<HTMLButtonElement>("export");
  const reason = overflowReason();
  btn.disabled = uiBusy || Boolean(reason);
  if (reason) {
    wrap.dataset.tip = reason;
    wrap.classList.add("blocked");
  } else {
    delete wrap.dataset.tip;
    wrap.classList.remove("blocked");
  }
}

function syncBinDownload(): void {
  const dl = el<HTMLButtonElement>("bin-dl");
  const clear = el<HTMLButtonElement>("bin-clear");
  const has = state.bins.length > 0;
  dl.hidden = !has;
  dl.disabled = uiBusy || !has;
  clear.hidden = !has || state.lab === "extract";
  clear.disabled = uiBusy || !has;
}

function setBusy(busy: boolean): void {
  uiBusy = busy;
  for (const id of ["embed", "extract", "wipe", "gpt-gen", "gpt-open"]) {
    el<HTMLButtonElement>(id).disabled = busy;
  }
  el<HTMLTextAreaElement>("gpt-prompt").disabled = busy;
  el<HTMLInputElement>("bin-file").disabled = busy;
  syncExportButton();
  syncBinDownload();
}

const MSG_PLACEHOLDER = "enter dead-drop text — embed writes LSBs";
const EXTRACT_PLACEHOLDER = "recovered text lands here after EXTRACT";

function payloadTitle(): string {
  if (state.lab === "extract") return "RECOVERED";
  if (state.io === "bin") return "BINARY";
  return "PAYLOAD";
}

function setGptPane(open: boolean): void {
  el("gpt-pane").hidden = !open;
  el("gpt-open").classList.toggle("active", open);
  el("gpt-open").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) el<HTMLTextAreaElement>("gpt-prompt").focus();
}

function applyLabMode(mode: "embed" | "extract", silent = false): void {
  state.lab = mode;
  el("app").setAttribute("data-lab", mode);
  document.querySelectorAll("#lab-mode button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.lab === mode);
  });
  try {
    localStorage.setItem(LAB_STORE, mode);
  } catch {
    /* ignore quota */
  }
  if (mode === "extract") setGptPane(false);
  el("payload-title").textContent = payloadTitle();
  el("empty-lead").textContent = mode === "extract" ? "DROP A STEGO PNG" : "DROP, SYNTH, OR GPT A CARRIER";
  el("empty-dim").textContent =
    mode === "extract"
      ? "Then enter the key if it was encrypted, and EXTRACT."
      : "Hide a payload in PNG LSBs. PNG preferred; export is always PNG.";
  el<HTMLInputElement>("key").placeholder =
    mode === "extract" ? "enter the embed key if the payload was encrypted" : "optional — empty keeps cleartext";
  el<HTMLTextAreaElement>("message").placeholder = mode === "extract" ? EXTRACT_PLACEHOLDER : MSG_PLACEHOLDER;
  refreshIntel();
  if (!silent && !state.original) {
    setStatus(mode === "extract" ? "STANDBY // LOAD A STEGO PNG TO EXTRACT" : "STANDBY // LOAD OR SYNTH A CARRIER TO EMBED");
  }
}

function applyIoMode(mode: "msg" | "bin"): void {
  state.io = mode;
  el("payload-panel").setAttribute("data-mode", mode);
  el("payload-title").textContent = payloadTitle();
  el<HTMLTextAreaElement>("message").placeholder =
    state.lab === "extract" ? EXTRACT_PLACEHOLDER : MSG_PLACEHOLDER;
  document.querySelectorAll("#io-mode button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.mode === mode);
  });
  refreshIntel();
}

function refreshPipe(): void {
  const pipe = el("pipe-label");
  const proto = el("proto");
  const filePipe = state.io === "bin";
  const many = state.bins.length !== 1;
  if (keyed()) {
    const cipher = cipherValue() || "cipher";
    pipe.textContent = filePipe ? `${many ? "FILES" : "FILE"} → ENC → LSB` : "TEXT → ENC → LSB";
    pipe.classList.add("hot");
    proto.textContent = `FRAME  DDRS · u32be LEN · u32be SEED · RAW OPENSSL
WALK   header sequential · payload bits scattered (seeded Feistel)
PIPE   ${filePipe ? "DDFILE envelope · " : ""}${cipher} · pbkdf2 / 10000 iter · salt · no Base64
MATCH  bits, channels, cipher, and key must match`;
  } else if (filePipe) {
    pipe.textContent = many ? "FILES → LSB" : "FILE → LSB";
    pipe.classList.remove("hot");
    proto.textContent = `FRAME  DDRS · u32be LEN · u32be SEED · DDFILE + RAW BYTES
WALK   header sequential · payload bits scattered (seeded Feistel)
PIPE   FILE → LSB  (UTF-8 is only for text)
MATCH  extract bits/channels must match embed`;
  } else {
    pipe.textContent = "TEXT → LSB";
    pipe.classList.remove("hot");
    proto.textContent = `FRAME  DDRS · u32be LEN · u32be SEED · UTF-8 PAYLOAD
WALK   header sequential · payload bits scattered (seeded Feistel)
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
    refreshBinInfo();
    syncExportButton();
    syncBinDownload();
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
  refreshBinInfo();

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

  syncExportButton();
  syncBinDownload();
}

function fileStatus(files: PackedFile[]): string {
  if (files.length === 1) return `FILE ${files[0].name} · ${formatBytes(files[0].bytes.length)} RAW`;
  const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  return `${files.length} FILES · ${formatBytes(bytes)} RAW`;
}

async function revealPayload(bytes: Uint8Array, prefix: string): Promise<void> {
  const box = el<HTMLTextAreaElement>("message");
  const direct = recoverFiles(bytes);
  if (direct.length) {
    state.heldFrame = null;
    armBinaries(direct, true);
    applyIoMode("bin");
    setStatus(`${prefix} · ${fileStatus(direct)}`, "ok");
    return;
  }

  if (keyed()) {
    try {
      const plain = await cryptRaw("decrypt", cipherValue(), keyValue(), bytes);
      const packed = recoverFiles(plain);
      if (packed.length) {
        state.heldFrame = null;
        armBinaries(packed, true);
        applyIoMode("bin");
        setStatus(`${prefix} · ${fileStatus(packed)} · DECRYPTED`, "ok");
        return;
      }
      const decoded = fromUtf8(plain);
      state.heldFrame = null;
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
      const detail = error instanceof Error ? error.message : "DECRYPT FAILED";
      setStatus(`${prefix} · CIPHERTEXT HELD · ${cipherValue()} · ${detail}`, "err");
      return;
    }
  }

  if (frameLooksKeyed(bytes)) {
    setStatus(`${prefix} · OPENSSL BLOB — ENTER KEY AND EXTRACT`, "warn");
    return;
  }

  const decoded = fromUtf8(bytes);
  if (decoded.binary) {
    setStatus(`${prefix} · BINARY FRAME ${bytes.length} B — ENTER KEY AND EXTRACT IF IT WAS ENCRYPTED`, "warn");
    return;
  }
  state.heldFrame = null;
  clearBin();
  applyIoMode("msg");
  box.value = decoded.text;
  refreshIntel();
  setStatus(`${prefix} · ${bytes.length} B`, "ok");
}

type PersistTarget = LibraryFolder | false;
type ShelfResult = { name: string; skipped: boolean };

async function imageDataToBlob(image: ImageData): Promise<Blob> {
  const text: Record<string, string> = {};
  const cipher = cipherValue();
  if (keyed() && cipher) text["dd-cipher"] = cipher;
  const png = await encodePng(image, text);
  const copy = new Uint8Array(png.byteLength);
  copy.set(png);
  return new Blob([copy], { type: "image/png" });
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

function setView(view: View): void {
  state.view = view;
  document.querySelectorAll(".view-switch button").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.view === view);
  });
}

function applyBits(bits: BitsPerChannel): void {
  state.bits = bits;
  document.querySelectorAll("#bits-seg button").forEach((btn) => {
    btn.classList.toggle("active", Number((btn as HTMLElement).dataset.bits) === bits);
  });
}

function detectFrame(image: ImageData): { payload: Uint8Array; cfg: StegConfig } | null {
  const attempts: StegConfig[] = [config()];
  for (const bitsPerChannel of [1, 2, 3, 4] as BitsPerChannel[]) {
    attempts.push({ bitsPerChannel, channels: { r: true, g: true, b: true } });
  }
  const seen = new Set<string>();
  for (const cfg of attempts) {
    const key = `${cfg.bitsPerChannel}:${Number(cfg.channels.r)}${Number(cfg.channels.g)}${Number(cfg.channels.b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return { payload: extract(image, cfg), cfg };
    } catch {
      /* try next bits/channels */
    }
  }
  return null;
}

async function ingest(image: ImageData, name: string, persist: PersistTarget = "source", pngBlob?: Blob): Promise<void> {
  state.name = name;
  viewCam.userMoved = false;

  const found = detectFrame(image);
  const dest: PersistTarget = persist && found ? "output" : persist;
  let shelved = "";
  if (dest) {
    const saved = await persistPng(dest, name, pngBlob ?? image);
    shelved = shelfNote(dest, saved);
  }

  if (found) {
    if (found.cfg.bitsPerChannel !== state.bits) applyBits(found.cfg.bitsPerChannel);
    if (
      found.cfg.channels.r !== state.channels.r ||
      found.cfg.channels.g !== state.channels.g ||
      found.cfg.channels.b !== state.channels.b
    ) {
      state.channels = { ...found.cfg.channels };
      document.querySelectorAll("#ch-seg button").forEach((btn) => {
        const ch = (btn as HTMLElement).dataset.ch as keyof ChannelMask;
        btn.classList.toggle("active", state.channels[ch]);
      });
    }
    state.stego = image;
    state.original = stripFrame(image, found.cfg);
    state.heldFrame = found.payload;
    el<HTMLTextAreaElement>("message").value = "";
    clearBin();
    applyIoMode("msg");
    applyLabMode("extract", true);
    setView("stego");
    syncSizeControls(image.width, image.height);
    refreshView();
    refreshIntel();
    const hint = frameLooksKeyed(found.payload)
      ? `OPENSSL FRAME · ${cipherValue() || "aes-256-cbc"} · ENTER KEY AND EXTRACT`
      : "EXTRACT TO OPEN PAYLOAD";
    setStatus(`STEGO INGESTED · ${name} · ${found.payload.length.toLocaleString()} B HELD · ${hint}${shelved}`, "ok");
    return;
  }

  state.original = image;
  state.stego = null;
  state.heldFrame = null;
  applyLabMode("embed", true);
  setView("carrier");
  syncSizeControls(image.width, image.height);
  refreshView();
  refreshIntel();
  setStatus(`CARRIER INGESTED · ${name} · CLEAN — NO DDRS FRAME${shelved}`, "ok");
}

function imageFromBitmap(source: CanvasImageSource, width: number, height: number): ImageData {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const offCtx = off.getContext("2d");
  if (!offCtx) throw new Error("NO OFFSCREEN CONTEXT");
  offCtx.imageSmoothingEnabled = !(
    source instanceof ImageBitmap && source.width === width && source.height === height
  );
  offCtx.imageSmoothingQuality = "high";
  offCtx.drawImage(source, 0, 0, width, height);
  return offCtx.getImageData(0, 0, width, height);
}

const RAW_BITMAP: ImageBitmapOptions = {
  colorSpaceConversion: "none",
  premultiplyAlpha: "none",
};

async function bitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, RAW_BITMAP);
}

async function ingestBlob(blob: Blob, name: string, persist: PersistTarget = "source"): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isPngBytes(bytes)) {
    const decoded = await decodePng(bytes);
    applyStoredCipher(decoded.text["dd-cipher"]);
    const png = blob.type === "image/png" ? blob : new Blob([bytes], { type: "image/png" });
    await ingest(pngToImageData(decoded), name, persist, png);
    return;
  }
  const bitmap = await bitmapFromBlob(new Blob([bytes], { type: blob.type || "application/octet-stream" }));
  await ingest(imageFromBitmap(bitmap, bitmap.width, bitmap.height), name, persist);
  bitmap.close();
}

async function loadFile(file: File): Promise<void> {
  await ingestBlob(file, file.name);
}

async function loadBlob(blob: Blob, name: string): Promise<void> {
  await ingestBlob(blob, name);
}

async function loadUrl(url: string): Promise<void> {
  setStatus(`PULLING ${url} …`);
  try {
    const response = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const headerName = response.headers.get("X-Remote-Name");
    const name = headerName ? decodeURIComponent(headerName) : url.split("/").pop() || "remote.png";
    await loadBlob(blob, name);
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
    if (state.io === "bin" && !state.bins.length) {
      setStatus("NO BINARY ARMED — DROP FILES ONTO PAYLOAD OR USE ADD FILES", "err");
      return;
    }
    setBusy(true);
    let payload: Uint8Array;
    const filePayload = state.io === "bin" ? joinEnvelopes(state.bins.map((item) => item.packed)) : null;
    if (filePayload) {
      payload = filePayload;
      if (keyed()) {
        setStatus(`ENCRYPTING ${cipherValue()} …`);
        payload = await cryptRaw("encrypt", cipherValue(), keyValue(), payload);
      }
    } else {
      let wire = el<HTMLTextAreaElement>("message").value;
      if (keyed()) {
        setStatus(`ENCRYPTING ${cipherValue()} …`);
        payload = await cryptRaw("encrypt", cipherValue(), keyValue(), toUtf8(wire));
      } else {
        payload = toUtf8(wire);
      }
    }
    state.stego = embed(state.original, payload, config());
    state.heldFrame = null;
    setView("stego");
    refreshView();
    refreshIntel();
    const pipe = keyed()
      ? ` · ${cipherValue()}`
      : filePayload
        ? ` · ${state.bins.length} DDFILE${state.bins.length === 1 ? "" : "S"} RAW`
        : "";
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
  if (state.io === "bin" && state.bins.length) {
    const n = state.bins.length;
    return `${n} FILE${n === 1 ? "" : "S"} · ${formatBytes(used)}${wireNote}`;
  }
  return `${used.toLocaleString()} B${wireNote}`;
}

function blobFromBytes(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: mime });
}

function binKind(mime: string): "image" | "audio" | "video" | "pdf" | "file" {
  if (isImage(mime)) return "image";
  if (isAudio(mime)) return "audio";
  if (isVideo(mime)) return "video";
  if (isPdf(mime)) return "pdf";
  return "file";
}

function clearBin(): void {
  for (const item of state.bins) URL.revokeObjectURL(item.url);
  state.bins = [];
  state.binFromExtract = false;
  renderBinList();
  refreshBinInfo();
  syncBinDownload();
}

function refreshBinInfo(): void {
  const n = state.bins.length;
  if (!n) {
    el("bin-info").textContent = "DROP FILES HERE — IMAGES SHOW BEFORE EMBED";
    return;
  }
  const cap = currentCap();
  const raw = state.bins.reduce((sum, item) => sum + item.packed.bytes.length, 0);
  const wire = estimateWiredBytes(
    state.bins.reduce((sum, item) => sum + item.packed.envelope.length, 0),
    keyed(),
  );
  const over = Boolean(cap && wire > cap.payloadBytes);
  const names = n === 1 ? state.bins[0].packed.name : `${n} FILES`;
  el("bin-info").textContent = `${names}  ·  RAW ${formatBytes(raw)}  →  ${formatBytes(wire)} IN IMAGE${over ? "  OVER SLOT" : ""}`;
}

function armBinary(packed: PackedFile, fromExtract = false): void {
  const mime = sniffMime(packed.bytes) || packed.mime;
  packed = mime === packed.mime ? packed : { ...packed, mime };
  const url = URL.createObjectURL(blobFromBytes(packed.bytes, packed.mime));
  state.bins.push({ packed, url });
  if (fromExtract) state.binFromExtract = true;
}

function armBinaries(files: PackedFile[], fromExtract = false): void {
  clearBin();
  state.binFromExtract = fromExtract;
  for (const packed of files) armBinary(packed, fromExtract);
  renderBinList();
  refreshBinInfo();
  syncBinDownload();
}

function removeBin(index: number): void {
  const item = state.bins[index];
  if (!item) return;
  URL.revokeObjectURL(item.url);
  state.bins.splice(index, 1);
  renderBinList();
  refreshIntel();
}

function renderBinList(): void {
  const list = el("bin-list");
  list.replaceChildren();
  list.dataset.count = String(state.bins.length);
  if (!state.bins.length) {
    const empty = document.createElement("div");
    empty.className = "bin-empty";
    empty.textContent = "DROP FILES OR IMAGES HERE";
    list.append(empty);
    return;
  }
  state.bins.forEach((item, index) => {
    const { packed, url } = item;
    const kind = binKind(packed.mime);
    const card = document.createElement("article");
    card.className = "bin-card";
    card.dataset.kind = kind;
    if (kind === "image") {
      const image = document.createElement("img");
      image.className = "bin-thumb";
      image.alt = packed.name;
      image.src = url;
      card.append(image);
    } else if (kind === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      card.append(audio);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.src = url;
      card.append(video);
    } else if (kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "bin-pdf-frame";
      frame.title = packed.name;
      frame.src = url;
      card.append(frame);
    } else {
      const glyph = document.createElement("div");
      glyph.className = "bin-glyph";
      glyph.textContent = packed.name.split(".").pop()?.toUpperCase() || "FILE";
      card.append(glyph);
    }
    const meta = document.createElement("div");
    meta.className = "bin-card-meta";
    const name = document.createElement("div");
    name.className = "bin-card-name";
    name.textContent = packed.name;
    name.title = packed.name;
    const size = document.createElement("div");
    size.className = "bin-card-size";
    size.textContent = formatBytes(packed.bytes.length);
    const actions = document.createElement("div");
    actions.className = "bin-card-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "OPEN";
    open.title = "Open as a data: Base64 URL in a new tab";
    open.addEventListener("click", () => openBinaryTab(index));
    const get = document.createElement("button");
    get.type = "button";
    get.textContent = "GET";
    get.addEventListener("click", () => saveBinaryAt(index));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${packed.name}`);
    remove.addEventListener("click", () => removeBin(index));
    actions.append(open, get, remove);
    meta.append(name, size, actions);
    card.append(meta);
    list.append(card);
  });
}

async function loadBinaryFiles(files: File[]): Promise<void> {
  const incoming = files.filter((file) => file.size > 0);
  if (!incoming.length) return;
  applyIoMode("bin");
  for (const file of incoming) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    armBinary(packFile(file.name, guessMime(file.name, file.type), bytes));
  }
  renderBinList();
  refreshIntel();
  const cap = currentCap();
  const used = payloadBytes();
  const label = incoming.length === 1 ? incoming[0].name : `${incoming.length} FILES`;
  if (cap && used > cap.payloadBytes) {
    setStatus(`FILES ARMED · OVER CAPACITY · ${formatBytes(used)} > ${formatBytes(cap.payloadBytes)}`, "err");
  } else {
    setStatus(`ARMED ${label} · ${state.bins.length} IN PAYLOAD`, "ok");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function binaryDataUrl(packed: PackedFile): string {
  const mime = packed.mime.trim() || "application/octet-stream";
  return `data:${mime};base64,${bytesToBase64(packed.bytes)}`;
}

function dataTabHtml(packed: PackedFile, dataUrl: string): string {
  const title = escapeHtml(packed.name);
  const kind = binKind(packed.mime);
  const media =
    kind === "image"
      ? `<img src="${dataUrl}" alt="${title}">`
      : kind === "audio"
        ? `<audio src="${dataUrl}" controls autoplay></audio>`
        : kind === "video"
          ? `<video src="${dataUrl}" controls autoplay></video>`
          : `<iframe src="${dataUrl}" title="${title}"></iframe>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0b0f0c; }
    body { display: grid; place-items: center; }
    img, video { max-width: 100%; max-height: 100vh; }
    audio, iframe { width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>${media}</body>
</html>`;
}

function paintDataTab(tab: Window, packed: PackedFile, dataUrl: string): void {
  tab.document.open();
  tab.document.write(dataTabHtml(packed, dataUrl));
  tab.document.close();
}

function openDataTabByLink(packed: PackedFile, dataUrl: string): void {
  const blob = new Blob([dataTabHtml(packed, dataUrl)], { type: "text/html" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

function openBinaryTab(index: number): void {
  const item = state.bins[index];
  if (!item) {
    setStatus("NO BINARY ARMED", "err");
    return;
  }
  const dataUrl = binaryDataUrl(item.packed);
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    openDataTabByLink(item.packed, dataUrl);
    setStatus(`OPENED ${item.packed.name} · DATA URL`, "ok");
    return;
  }
  try {
    tab.location.replace(dataUrl);
  } catch {
    paintDataTab(tab, item.packed, dataUrl);
    setStatus(`OPENED ${item.packed.name} · DATA URL`, "ok");
    return;
  }
  window.setTimeout(() => {
    try {
      if (!tab.closed && tab.location.href === "about:blank") {
        paintDataTab(tab, item.packed, dataUrl);
      }
    } catch {
      /* navigated to the data: URL */
    }
  }, 0);
  setStatus(`OPENED ${item.packed.name} · DATA URL`, "ok");
}

function saveBinaryAt(index: number): void {
  const item = state.bins[index];
  if (!item) {
    setStatus("NO BINARY ARMED", "err");
    return;
  }
  const a = document.createElement("a");
  a.href = item.url;
  a.download = item.packed.name;
  a.click();
  setStatus(`SAVED ${item.packed.name} · ${formatBytes(item.packed.bytes.length)}`, "ok");
}

async function saveAllBinaries(): Promise<void> {
  if (!state.bins.length) {
    setStatus("NO BINARY ARMED", "err");
    return;
  }
  for (let i = 0; i < state.bins.length; i++) {
    saveBinaryAt(i);
    if (i < state.bins.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

function filesFromDrop(event: DragEvent): File[] {
  return [...(event.dataTransfer?.files ?? [])];
}

function dropHasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function b64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function onGptGen(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>("gpt-prompt").value.trim();
  if (!prompt) {
    setGptPane(true);
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
    const bitmap = await bitmapFromBlob(blob);
    const raster = imageFromBitmap(bitmap, size.width, size.height);
    bitmap.close();
    await ingest(raster, `GPT-${targetKey}.png`, "source");
    setStatus(`GPT CARRIER LOCKED · ${result.model} ${result.apiSize} → ${size.width}×${size.height}`, "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "GPT IMAGE FAILED", "err");
  } finally {
    setBusy(false);
  }
}

async function onExport(): Promise<void> {
  const blocked = overflowReason();
  if (blocked) {
    setStatus(blocked, "err");
    return;
  }
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
  state.heldFrame = null;
  setView("carrier");
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
    closeLibrary();
    await ingestBlob(blob, name, false);
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
    select.value = pendingCipher || localStorage.getItem(CIPHER_STORE) || "aes-256-cbc";
    if (!select.value) select.value = "aes-256-cbc";
    if (!select.value && select.options.length > 0) {
      select.selectedIndex = 0;
    }
    pendingCipher = "";
    rememberCipher();
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

function syncSizeControls(width: number, height: number): void {
  el<HTMLInputElement>("synth-w").value = String(width);
  el<HTMLInputElement>("synth-h").value = String(height);
  matchPreset();
  refreshSynthTarget();
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
  syncSizeControls(state.original.width, state.original.height);
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
  wireSplitters();

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

  document.querySelectorAll("#lab-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyLabMode(((btn as HTMLElement).dataset.lab as "embed" | "extract") ?? "embed");
    });
  });

  el("embed").addEventListener("click", () => void onEmbed());
  el("extract").addEventListener("click", () => void onExtract());
  el("gpt-open").addEventListener("click", () => {
    setGptPane(el("gpt-pane").hidden);
  });
  el("gpt-gen").addEventListener("click", () => void onGptGen());
  el<HTMLTextAreaElement>("gpt-prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void onGptGen();
    }
  });
  el("bin-dl").addEventListener("click", () => void saveAllBinaries());
  el("bin-clear").addEventListener("click", () => {
    clearBin();
    refreshIntel();
    setStatus("BINARY PAYLOAD CLEARED", "warn");
  });
  el("export").addEventListener("click", () => void onExport());
  el("wipe").addEventListener("click", onWipe);

  el<HTMLInputElement>("bin-file").addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) await loadBinaryFiles(files);
  });
  const payload = el("payload-panel");
  payload.addEventListener("dragover", (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    payload.classList.add("drop-files");
  });
  payload.addEventListener("dragleave", (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && payload.contains(next)) return;
    payload.classList.remove("drop-files");
  });
  payload.addEventListener("drop", async (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    payload.classList.remove("drop-files");
    const files = filesFromDrop(event);
    if (files.length) await loadBinaryFiles(files);
  });

  document.querySelectorAll("#io-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyIoMode(((btn as HTMLElement).dataset.mode as "msg" | "bin") ?? "msg");
    });
  });

  const onCryptoChange = () => {
    rememberCipher();
    refreshIntel();
  };
  el("key").addEventListener("input", onCryptoChange);
  el("cipher").addEventListener("change", onCryptoChange);
  el("key-vis").addEventListener("click", () => {
    const input = el<HTMLInputElement>("key");
    const btn = el<HTMLButtonElement>("key-vis");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", show ? "true" : "false");
    btn.setAttribute("aria-label", show ? "Hide key" : "Show key");
    btn.title = show ? "Hide key" : "Show key";
  });

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
      setView(((btn as HTMLElement).dataset.view as View) ?? "carrier");
      if (state.view === "delta" && !state.stego) {
        setStatus("DELTA NEEDS AN EMBED FIRST", "warn");
      }
      refreshView();
    });
  });

  document.querySelectorAll("#bits-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyBits(Number((btn as HTMLElement).dataset.bits) as BitsPerChannel);
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
    if (event.key === "Escape") {
      closeModals();
      if (!el("gpt-pane").hidden) setGptPane(false);
    }
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
      if (state.lab === "extract") void onExtract();
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
  let savedLab: string | null = null;
  try {
    savedLab = localStorage.getItem(LAB_STORE);
  } catch {
    savedLab = null;
  }
  applyLabMode(savedLab === "extract" ? "extract" : "embed");
  renderBinList();
  refreshIntel();
}

wireUi();
