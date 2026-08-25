import { inflate } from "node:zlib";
import { promisify } from "node:util";

const inflateAsync = promisify(inflate);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type DecodedPng = {
  width: number;
  height: number;
  rgba: Buffer;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const destOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = row[i];
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

function toRgba(pixels: Buffer, width: number, height: number, colorType: number): Buffer {
  const count = width * height;
  const rgba = Buffer.alloc(count * 4);
  if (colorType === 6) {
    pixels.copy(rgba);
    return rgba;
  }
  if (colorType === 2) {
    for (let i = 0, p = 0; i < count; i++, p += 3) {
      const o = i * 4;
      rgba[o] = pixels[p];
      rgba[o + 1] = pixels[p + 1];
      rgba[o + 2] = pixels[p + 2];
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const g = pixels[i];
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
      const g = pixels[p];
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = pixels[p + 1];
    }
    return rgba;
  }
  throw new Error("UNSUPPORTED PNG COLOR TYPE");
}

export async function decodePng(png: Buffer): Promise<DecodedPng> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("NOT A PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("BAD PNG HEADER");
  if (bitDepth !== 8) throw new Error("UNSUPPORTED PNG BIT DEPTH");
  if (interlace !== 0) throw new Error("INTERLACED PNG");
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!bpp) throw new Error("UNSUPPORTED PNG COLOR TYPE");
  const raw = await inflateAsync(Buffer.concat(idat));
  const expected = height * (1 + width * bpp);
  if (raw.length < expected) throw new Error("PNG DATA SHORT");
  const filtered = unfilter(raw.subarray(0, expected), width, height, bpp);
  return { width, height, rgba: toRgba(filtered, width, height, colorType) };
}
