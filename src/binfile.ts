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

export function unpackFile(data: Uint8Array): PackedFile | null {
  if (!startsWith(data, MAGIC)) return null;
  const rest = data.subarray(MAGIC.length);
  const nl = indexOfByte(rest, 10);
  if (nl < 0) return null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(rest.subarray(0, nl))) as {
      name?: string;
      mime?: string;
      n?: number;
    };
    let body = rest.subarray(nl + 1);
    if (typeof meta.n === "number" && body.length !== meta.n) {
      try {
        const decoded = base64ToBytes(new TextDecoder("utf-8", { fatal: true }).decode(body));
        if (decoded.length === meta.n) body = decoded;
      } catch {
        /* keep raw body — not the old Base64 envelope */
      }
    }
    const name = meta.name?.trim() || "payload.bin";
    const mime = meta.mime?.trim() || "application/octet-stream";
    return { name, mime, bytes: body, envelope: data };
  } catch {
    return null;
  }
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
    pdf: "application/pdf",
    zip: "application/zip",
    bin: "application/octet-stream",
  };
  return map[ext] || "application/octet-stream";
}

export function isAudio(mime: string): boolean {
  return mime.startsWith("audio/");
}
