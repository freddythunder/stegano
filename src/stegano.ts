/** Dead Drop frame: magic + payload length, then UTF-8 bytes in pixel LSBs. */

export const MAGIC = new TextEncoder().encode("DDRP");
export const HEADER_BYTES = 8;

export type BitsPerChannel = 1 | 2 | 3 | 4;

export interface ChannelMask {
  r: boolean;
  g: boolean;
  b: boolean;
}

export interface StegConfig {
  bitsPerChannel: BitsPerChannel;
  channels: ChannelMask;
}

export interface CapacityReport {
  width: number;
  height: number;
  pixels: number;
  channelsUsed: number;
  bitsPerChannel: number;
  bitsPerPixel: number;
  totalBits: number;
  headerBytes: number;
  payloadBytes: number;
}

const DEFAULT_CHANNELS: ChannelMask = { r: true, g: true, b: true };

export function channelIndices(mask: ChannelMask = DEFAULT_CHANNELS): number[] {
  const idx: number[] = [];
  if (mask.r) idx.push(0);
  if (mask.g) idx.push(1);
  if (mask.b) idx.push(2);
  return idx;
}

export function capacity(width: number, height: number, config: StegConfig): CapacityReport {
  const channelsUsed = channelIndices(config.channels).length;
  const bitsPerPixel = channelsUsed * config.bitsPerChannel;
  const totalBits = width * height * bitsPerPixel;
  const payloadBits = Math.max(0, totalBits - HEADER_BYTES * 8);
  return {
    width,
    height,
    pixels: width * height,
    channelsUsed,
    bitsPerChannel: config.bitsPerChannel,
    bitsPerPixel,
    totalBits,
    headerBytes: HEADER_BYTES,
    payloadBytes: Math.floor(payloadBits / 8),
  };
}

export function cloneImageData(source: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

class LsbCursor {
  private pixel = 0;
  private channel = 0;
  private bit = 0;
  private readonly data: Uint8ClampedArray;
  private readonly width: number;
  private readonly height: number;
  private readonly channels: number[];
  private readonly bitsPerChannel: number;

  constructor(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    channels: number[],
    bitsPerChannel: number,
  ) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.bitsPerChannel = bitsPerChannel;
    if (this.channels.length === 0) {
      throw new Error("NO CHANNELS ARMED");
    }
  }

  private get maxPixels(): number {
    return this.width * this.height;
  }

  writeBit(value: 0 | 1): void {
    this.assertInBounds();
    const index = this.pixel * 4 + this.channels[this.channel];
    const mask = 1 << this.bit;
    this.data[index] = value ? this.data[index] | mask : this.data[index] & ~mask;
    this.advance();
  }

  readBit(): 0 | 1 {
    this.assertInBounds();
    const index = this.pixel * 4 + this.channels[this.channel];
    const bit = ((this.data[index] >> this.bit) & 1) as 0 | 1;
    this.advance();
    return bit;
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      for (let i = 7; i >= 0; i--) {
        this.writeBit(((byte >> i) & 1) as 0 | 1);
      }
    }
  }

  readBytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let n = 0; n < count; n++) {
      let byte = 0;
      for (let i = 7; i >= 0; i--) {
        byte |= this.readBit() << i;
      }
      out[n] = byte;
    }
    return out;
  }

  private assertInBounds(): void {
    if (this.pixel >= this.maxPixels) {
      throw new Error("CARRIER EXHAUSTED");
    }
  }

  private advance(): void {
    this.bit += 1;
    if (this.bit >= this.bitsPerChannel) {
      this.bit = 0;
      this.channel += 1;
      if (this.channel >= this.channels.length) {
        this.channel = 0;
        this.pixel += 1;
      }
    }
  }
}

export type PixelRaster = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

function cursorFor(image: PixelRaster, config: StegConfig): LsbCursor {
  return new LsbCursor(
    image.data,
    image.width,
    image.height,
    channelIndices(config.channels),
    config.bitsPerChannel,
  );
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readU32be(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function magicOk(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MAGIC.length &&
    MAGIC.every((value, index) => bytes[index] === value)
  );
}

export function embed(source: ImageData, payload: Uint8Array, config: StegConfig): ImageData {
  const cap = capacity(source.width, source.height, config);
  if (config.channels.r === false && config.channels.g === false && config.channels.b === false) {
    throw new Error("NO CHANNELS ARMED");
  }
  if (payload.length > cap.payloadBytes) {
    throw new Error(`CAPACITY EXCEEDED (${payload.length} > ${cap.payloadBytes} BYTES)`);
  }

  const stego = cloneImageData(source);
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  frame.set(MAGIC, 0);
  frame.set(u32be(payload.length), 4);
  frame.set(payload, HEADER_BYTES);

  cursorFor(stego, config).writeBytes(frame);
  return stego;
}

export function extract(source: PixelRaster, config: StegConfig): Uint8Array {
  const cap = capacity(source.width, source.height, config);
  const reader = cursorFor(source, config);
  const header = reader.readBytes(HEADER_BYTES);

  if (!magicOk(header)) {
    throw new Error("NO FRAME DETECTED");
  }

  const length = readU32be(header, 4);
  if (length > cap.payloadBytes) {
    throw new Error("FRAME LENGTH CORRUPT");
  }

  return reader.readBytes(length);
}

/** Zero the LSB bits that hold the DDRP frame so SRC/DELTA have a clean original. */
export function stripFrame(source: ImageData, payloadBytes: number, config: StegConfig): ImageData {
  const clean = cloneImageData(source);
  cursorFor(clean, config).writeBytes(new Uint8Array(HEADER_BYTES + payloadBytes));
  return clean;
}

export function hasFrame(source: ImageData, config: StegConfig): boolean {
  try {
    const header = cursorFor(source, config).readBytes(HEADER_BYTES);
    if (!magicOk(header)) return false;
    const length = readU32be(header, 4);
    const cap = capacity(source.width, source.height, config);
    return length <= cap.payloadBytes;
  } catch {
    return false;
  }
}

export function visualizeLsb(source: ImageData, config: StegConfig): ImageData {
  const out = new ImageData(source.width, source.height);
  const mask = (1 << config.bitsPerChannel) - 1;
  const scale = mask === 0 ? 1 : 255 / mask;
  const use = config.channels;

  for (let i = 0; i < source.data.length; i += 4) {
    out.data[i] = use.r ? Math.round((source.data[i] & mask) * scale) : 0;
    out.data[i + 1] = use.g ? Math.round((source.data[i + 1] & mask) * scale) : 0;
    out.data[i + 2] = use.b ? Math.round((source.data[i + 2] & mask) * scale) : 0;
    out.data[i + 3] = 255;
  }
  return out;
}

export function visualizeDelta(original: ImageData, stego: ImageData, amplify = 48): ImageData {
  const out = new ImageData(original.width, original.height);
  for (let i = 0; i < original.data.length; i += 4) {
    out.data[i] = Math.min(255, Math.abs(original.data[i] - stego.data[i]) * amplify);
    out.data[i + 1] = Math.min(255, Math.abs(original.data[i + 1] - stego.data[i + 1]) * amplify);
    out.data[i + 2] = Math.min(255, Math.abs(original.data[i + 2] - stego.data[i + 2]) * amplify);
    out.data[i + 3] = 255;
  }
  return out;
}

export function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): { text: string; binary: boolean } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      binary: false,
    };
  } catch {
    return { text: hexDump(bytes), binary: true };
  }
}

export function hexDump(bytes: Uint8Array, width = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    const slice = bytes.subarray(i, i + width);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const ascii = Array.from(slice)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(width * 3 - 1, " ")}  ${ascii}`);
  }
  return lines.join("\n");
}
