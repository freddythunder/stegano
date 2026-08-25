import { capacity, embed, extract, stripFrame, toUtf8, fromUtf8, type StegConfig } from "./stegano.ts";
import { decodePng, encodePng, pngToImageData } from "./png.ts";
import { crypt as opensslCrypt } from "../server/openssl.ts";

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
  const clean = stripFrame(stego, payload.length, config);
  try {
    extract(clean, config);
    throw new Error("stripped carrier should have no frame");
  } catch (error) {
    assert(error instanceof Error && error.message === "NO FRAME DETECTED", "strip should remove magic");
  }
  assert(extract(stego, config).length === payload.length, "stego payload must survive strip of the copy");
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

{
  const config = configs[0];
  const source = makeCarrier(64, 48);
  const stego = embed(source, payload, config);
  const png = await encodePng(stego, { "dd-cipher": "aes-256-cbc" });
  const decodedPng = await decodePng(png);
  assert(decodedPng.text["dd-cipher"] === "aes-256-cbc", "cipher tEXt");
  const back = pngToImageData(decodedPng);
  assert(back.width === stego.width && back.height === stego.height, "png size");
  for (let i = 0; i < stego.data.length; i++) {
    assert(stego.data[i] === back.data[i], `png pixel ${i}`);
  }
  const decoded = fromUtf8(extract(back, config));
  assert(!decoded.binary && decoded.text === message, "png encode must preserve LSBs");
}

{
  const config: StegConfig = { bitsPerChannel: 1, channels: { r: true, g: true, b: true } };
  const raw = new Uint8Array(2048);
  raw[0] = 0xff;
  raw[1] = 0xd8;
  for (let i = 2; i < raw.length; i++) raw[i] = i & 255;
  const header = new TextEncoder().encode(`DDFILE\n${JSON.stringify({ name: "x.jpg", mime: "image/jpeg", n: raw.length })}\n`);
  const envelope = new Uint8Array(header.length + raw.length);
  envelope.set(header);
  envelope.set(raw, header.length);
  const enc = await opensslCrypt("encrypt", "aes-256-cbc", "secret-key", envelope);
  const stego = embed(makeCarrier(160, 120), enc, config);
  const png = await encodePng(stego, { "dd-cipher": "aes-256-cbc" });
  const pulled = extract(pngToImageData(await decodePng(png)), config);
  const plain = await opensslCrypt("decrypt", "aes-256-cbc", "secret-key", pulled);
  assert(plain.length === envelope.length, "decrypted envelope length");
  assert(new TextDecoder().decode(plain.subarray(0, 7)) === "DDFILE\n", "ddfile magic");
  assert(plain[plain.length - raw.length] === 0xff, "jpeg magic after decrypt");
}

console.log("ok", configs.length, "roundtrips");
