export type DecodedPng = {
  width: number;
  height: number;
  rgba: Uint8Array;
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
  return { width, height, rgba: toRgba(filtered, width, height, colorType) };
}

export function pngToImageData(decoded: DecodedPng): ImageData {
  const data = new Uint8ClampedArray(decoded.rgba.length);
  data.set(decoded.rgba);
  return new ImageData(data, decoded.width, decoded.height);
}
