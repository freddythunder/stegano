export type DecodedPng = {
  width: number;
  height: number;
  rgba: Uint8Array;
  text: Record<string, string>;
};

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return PNG_MAGIC.every((value, i) => bytes[i] === value);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  const crcSrc = chunk.subarray(4, 8 + data.length);
  writeU32(chunk, 8 + data.length, crc32(crcSrc));
  return chunk;
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const destOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src++];
      const a = i >= bpp ? out[destOff + i - bpp] : 0;
      const b = y > 0 ? out[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? out[prevOff + i - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0:
          val = x;
          break;
        case 1:
          val = x + a;
          break;
        case 2:
          val = x + b;
          break;
        case 3:
          val = x + ((a + b) >> 1);
          break;
        case 4:
          val = x + paeth(a, b, c);
          break;
        default:
          throw new Error("BAD PNG FILTER");
      }
      out[destOff + i] = val & 255;
    }
  }
  return out;
}

function toRgba(pixels: Uint8Array, width: number, height: number, colorType: number): Uint8Array {
  const count = width * height;
  const rgba = new Uint8Array(count * 4);
  if (colorType === 6) {
    rgba.set(pixels);
    return rgba;
  }
  if (colorType === 2) {
    for (let i = 0, p = 0; i < count; i++, p += 3) {
      const o = i * 4;
      rgba[o] = pixels[p] ?? 0;
      rgba[o + 1] = pixels[p + 1] ?? 0;
      rgba[o + 2] = pixels[p + 2] ?? 0;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const g = pixels[i] ?? 0;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 4) {
    for (let i = 0, p = 0; i < count; i++, p += 2) {
      const o = i * 4;
      const g = pixels[p] ?? 0;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = pixels[p + 1] ?? 255;
    }
    return rgba;
  }
  throw new Error("UNSUPPORTED PNG COLOR TYPE");
}

export async function decodePng(png: Uint8Array): Promise<DecodedPng> {
  if (!isPngBytes(png)) throw new Error("NOT A PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  const text: Record<string, string> = {};
  while (offset + 8 <= png.length) {
    const len = u32(png, offset);
    const type = ascii(png, offset + 4, 4);
    const data = png.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "tEXt") {
      const z = data.indexOf(0);
      if (z > 0) {
        text[ascii(data, 0, z)] = ascii(data, z + 1, data.length - z - 1);
      }
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("BAD PNG HEADER");
  if (bitDepth !== 8) throw new Error("UNSUPPORTED PNG BIT DEPTH");
  if (interlace !== 0) throw new Error("INTERLACED PNG");
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!bpp) throw new Error("UNSUPPORTED PNG COLOR TYPE");
  const total = idat.reduce((n, chunk) => n + chunk.length, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of idat) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  const raw = await inflateZlib(merged);
  const expected = height * (1 + width * bpp);
  if (raw.length < expected) throw new Error("PNG DATA SHORT");
  const filtered = unfilter(raw.subarray(0, expected), width, height, bpp);
  return { width, height, rgba: toRgba(filtered, width, height, colorType), text };
}

export function pngToImageData(decoded: DecodedPng): ImageData {
  const data = new Uint8ClampedArray(decoded.rgba.length);
  data.set(decoded.rgba);
  return new ImageData(data, decoded.width, decoded.height);
}

function textChunk(keyword: string, value: string): Uint8Array | null {
  if (!keyword || keyword.length > 79 || /[\0\r\n]/.test(keyword) || value.includes("\0")) return null;
  const payload = new Uint8Array(keyword.length + 1 + value.length);
  for (let i = 0; i < keyword.length; i++) payload[i] = keyword.charCodeAt(i) & 255;
  payload[keyword.length] = 0;
  for (let i = 0; i < value.length; i++) payload[keyword.length + 1 + i] = value.charCodeAt(i) & 255;
  return pngChunk("tEXt", payload);
}

export async function encodePng(image: ImageData, text: Record<string, string> = {}): Promise<Uint8Array> {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + stride);
    raw[row] = 0;
    raw.set(data.subarray(y * stride, y * stride + stride), row + 1);
  }
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = await deflateZlib(raw);
  const parts = [PNG_MAGIC, pngChunk("IHDR", ihdr)];
  for (const [keyword, value] of Object.entries(text)) {
    const chunk = textChunk(keyword, value);
    if (chunk) parts.push(chunk);
  }
  parts.push(pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
