import { hexDump } from "./stegano.ts";

export type PackedFile = {
  name: string;
  mime: string;
  bytes: Uint8Array;
  envelope: Uint8Array;
};

const MAGIC = new TextEncoder().encode("DDFILE\n");

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function indexOfByte(data: Uint8Array, byte: number): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === byte) return i;
  }
  return -1;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((value, i) => data[i] === value);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function packFile(name: string, mime: string, bytes: Uint8Array): PackedFile {
  const safeName = name.replace(/[\r\n]/g, " ").trim() || "payload.bin";
  const safeMime = mime.trim() || "application/octet-stream";
  const header = new TextEncoder().encode(
    `DDFILE\n${JSON.stringify({ name: safeName, mime: safeMime, n: bytes.length })}\n`,
  );
  return {
    name: safeName,
    mime: safeMime,
    bytes,
    envelope: concat([header, bytes]),
  };
}

function unpackOne(data: Uint8Array, offset: number): { file: PackedFile; next: number } | null {
  const slice = data.subarray(offset);
  if (!startsWith(slice, MAGIC)) return null;
  const rest = slice.subarray(MAGIC.length);
  const nl = indexOfByte(rest, 10);
  if (nl < 0) return null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(rest.subarray(0, nl))) as {
      name?: string;
      mime?: string;
      n?: number;
    };
    const rawBody = rest.subarray(nl + 1);
    let body = rawBody;
    let bodyBytes = rawBody.length;
    if (typeof meta.n === "number") {
      if (rawBody.length >= meta.n) {
        body = rawBody.subarray(0, meta.n);
        bodyBytes = meta.n;
      } else {
        try {
          const decoded = base64ToBytes(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
          if (decoded.length === meta.n) {
            body = decoded;
            bodyBytes = rawBody.length;
          }
        } catch {
          /* keep raw body — not the old Base64 envelope */
        }
      }
    }
    const name = meta.name?.trim() || "payload.bin";
    const mime = meta.mime?.trim() || "application/octet-stream";
    const consumed = MAGIC.length + nl + 1 + bodyBytes;
    return {
      file: { name, mime, bytes: body, envelope: data.subarray(offset, offset + consumed) },
      next: offset + consumed,
    };
  } catch {
    return null;
  }
}

export function unpackFile(data: Uint8Array): PackedFile | null {
  return unpackOne(data, 0)?.file ?? null;
}

export function joinEnvelopes(files: PackedFile[]): Uint8Array {
  return concat(files.map((file) => file.envelope));
}

export function unpackFiles(data: Uint8Array): PackedFile[] {
  const start = locateBytes(data, MAGIC, 32);
  if (start < 0) return [];
  const files: PackedFile[] = [];
  let offset = start;
  while (offset < data.length) {
    const parsed = unpackOne(data, offset);
    if (!parsed) break;
    files.push(parsed.file);
    offset = parsed.next;
  }
  return files;
}

export function guessMime(name: string, reported = ""): string {
  if (reported.trim()) return reported.trim();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    webm: "audio/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
    zip: "application/zip",
    bin: "application/octet-stream",
  };
  return map[ext] || "application/octet-stream";
}

export function sniffMime(bytes: Uint8Array): string {
  return sniffMagic(bytes, true);
}

function sniffMagic(bytes: Uint8Array, weak: boolean): string {
  const at = (offset: number, ascii: string) =>
    offset + ascii.length <= bytes.length &&
    ascii.split("").every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "image/gif";
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (bytes.length >= 4 && at(0, "OggS")) return "audio/ogg";
  if (bytes.length >= 4 && at(0, "fLaC")) return "audio/flac";
  if (bytes.length >= 3 && at(0, "ID3")) return "audio/mpeg";
  if (bytes.length >= 8 && bytes[4] === 0x66 && at(4, "ftyp")) {
    return at(8, "M4A") || at(8, "mp4a") ? "audio/mp4" : "video/mp4";
  }
  if (bytes.length >= 5 && at(0, "%PDF-")) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "application/zip";
  }
  if (weak && looksLikeBmp(bytes)) return "image/bmp";
  if (weak && bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return "";
}

function looksLikeBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 14 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  const size = bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24);
  const pixelOff = bytes[10] | (bytes[11] << 8) | (bytes[12] << 16) | (bytes[13] << 24);
  return size >= 14 && size <= bytes.length && pixelOff >= 14 && pixelOff < size;
}

function locateBytes(data: Uint8Array, prefix: Uint8Array, limit: number): number {
  const last = Math.min(limit, Math.max(0, data.length - prefix.length));
  for (let i = 0; i <= last; i++) {
    if (startsWith(data.subarray(i), prefix)) return i;
  }
  return -1;
}

function sliceMedia(data: Uint8Array): { mime: string; bytes: Uint8Array } | null {
  const direct = sniffMagic(data, true);
  if (direct) return { mime: direct, bytes: data };
  const scan = Math.min(data.length, 4096);
  for (let i = 1; i < scan; i++) {
    const mime = sniffMagic(data.subarray(i), false);
    if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf") {
      return { mime, bytes: data.subarray(i) };
    }
  }
  return null;
}

function extForMime(mime: string): string {
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "image/jpeg") return "jpg";
  return mime.split("/")[1]?.split("+")[0] || "bin";
}

function refineMime(packed: PackedFile): PackedFile {
  const head = sniffMagic(packed.bytes, true);
  if (head && (packed.mime === "application/octet-stream" || packed.mime === "")) {
    return { ...packed, mime: head };
  }
  return packed;
}

export function recoverFile(data: Uint8Array): PackedFile | null {
  return recoverFiles(data)[0] ?? null;
}

export function recoverFiles(data: Uint8Array): PackedFile[] {
  const packed = unpackFiles(data).map(refineMime);
  if (packed.length) return packed;
  const media = sliceMedia(data);
  if (!media) return [];
  return [{ name: `payload.${extForMime(media.mime)}`, mime: media.mime, bytes: media.bytes, envelope: data }];
}

export function dumpEnvelope(packed: PackedFile): string {
  let header = "";
  if (startsWith(packed.envelope, MAGIC)) {
    const rest = packed.envelope.subarray(MAGIC.length);
    const nl = indexOfByte(rest, 10);
    if (nl >= 0) {
      header = new TextDecoder("utf-8", { fatal: false }).decode(
        packed.envelope.subarray(0, MAGIC.length + nl + 1),
      );
    }
  }
  const shown = Math.min(packed.bytes.length, 4096);
  const dump = hexDump(packed.bytes.subarray(0, shown));
  const more =
    packed.bytes.length > shown
      ? `\n… ${packed.bytes.length - shown} more bytes (${packed.bytes.length.toLocaleString()} B total)`
      : "";
  return header ? `${header.trimEnd()}\n\n${dump}${more}` : `${dump}${more}`;
}

export function isAudio(mime: string): boolean {
  return mime.startsWith("audio/");
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isVideo(mime: string): boolean {
  return mime.startsWith("video/");
}

export function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}
