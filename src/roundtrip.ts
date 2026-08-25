import { capacity, embed, extract, toUtf8, fromUtf8, type StegConfig } from "./stegano.ts";

class ImageDataPolyfill {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace = "srgb" as const;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

(globalThis as unknown as { ImageData: typeof ImageData }).ImageData = ImageDataPolyfill as unknown as typeof ImageData;

function makeCarrier(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 13) & 255;
    data[i + 1] = (i * 29) & 255;
    data[i + 2] = (i * 47) & 255;
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const configs: StegConfig[] = [
  { bitsPerChannel: 1, channels: { r: true, g: true, b: true } },
  { bitsPerChannel: 2, channels: { r: true, g: false, b: true } },
  { bitsPerChannel: 4, channels: { r: false, g: true, b: false } },
];

const message = "The eagle flies at midnight. 秘密 🛰️";
const payload = toUtf8(message);

for (const config of configs) {
  const source = makeCarrier(64, 48);
  const cap = capacity(64, 48, config);
  assert(payload.length <= cap.payloadBytes, "test payload should fit");
  const stego = embed(source, payload, config);
  const out = extract(stego, config);
  const decoded = fromUtf8(out);
  assert(!decoded.binary, "should be utf8");
  assert(decoded.text === message, `roundtrip mismatch for ${JSON.stringify(config)}`);
  assert(source.data[3] === 255 && stego.data[3] === 255, "alpha must stay opaque");
}

const tiny = makeCarrier(8, 8);
try {
  embed(tiny, payload, { bitsPerChannel: 1, channels: { r: true, g: true, b: true } });
  throw new Error("should have rejected oversize payload");
} catch (error) {
  assert(error instanceof Error && error.message.includes("CAPACITY EXCEEDED"), "capacity error");
}

try {
  extract(makeCarrier(32, 32), { bitsPerChannel: 1, channels: { r: true, g: true, b: true } });
  throw new Error("should have rejected empty carrier");
} catch (error) {
  assert(error instanceof Error && error.message === "NO FRAME DETECTED", "magic error");
}

console.log("ok", configs.length, "roundtrips");
