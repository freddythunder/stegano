/** Procedural night-ops carrier so the terminal is usable with no file. */

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed, 374761393) ^ Math.imul(y + seed, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const nx = x / scale;
  const ny = y / scale;
  const x0 = Math.floor(nx);
  const y0 = Math.floor(ny);
  const fx = nx - x0;
  const fy = ny - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}

function fbm(x: number, y: number, seed: number, baseScale: number): number {
  let value = 0;
  let amp = 0.55;
  let scale = baseScale;
  for (let i = 0; i < 5; i++) {
    value += valueNoise(x, y, scale, seed + i * 19) * amp;
    scale *= 0.48;
    amp *= 0.52;
  }
  return value;
}

export const SYNTH_MIN = 16;
export const SYNTH_MAX = 4096;

export function clampSynthDim(value: number): number {
  if (!Number.isFinite(value)) return 768;
  return Math.min(SYNTH_MAX, Math.max(SYNTH_MIN, Math.round(value)));
}

export function generateNightOpsCarrier(width = 768, height = 512): ImageData {
  width = clampSynthDim(width);
  height = clampSynthDim(height);
  const image = new ImageData(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const baseScale = Math.max(12, Math.min(width, height) * 0.125);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const terrain = fbm(x, y, 7, baseScale);
      const grain = hash2(x, y, 91) * 0.14;
      const radial = Math.hypot(x - cx, y - cy) / Math.hypot(cx, cy);
      const vignette = 1 - radial * 0.55;
      const scan = y % 3 === 0 ? 0.07 : 0;

      let v = (terrain * 0.86 + grain) * vignette - scan;
      v = Math.max(0, Math.min(1, v));

      const river = Math.abs(fbm(x * 0.7, y * 1.4, 23, baseScale) - 0.48);
      if (river < 0.045) v *= 0.55;

      const i = (y * width + x) * 4;
      const glow = v * v;
      image.data[i] = Math.round(18 + glow * 70);
      image.data[i + 1] = Math.round(38 + v * 170);
      image.data[i + 2] = Math.round(28 + glow * 90);
      image.data[i + 3] = 255;
    }
  }

  const reticle = Math.min(width, height) * 0.18;
  const tick = Math.max(4, Math.round(Math.min(width, height) * 0.035));
  stampReticle(image, cx, cy, reticle, tick);
  return image;
}

function stampReticle(image: ImageData, cx: number, cy: number, radius: number, tick: number): void {
  const { width, height, data } = image;
  const set = (x: number, y: number, a: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = Math.min(255, data[i] + 40 * a);
    data[i + 1] = Math.min(255, data[i + 1] + 90 * a);
    data[i + 2] = Math.min(255, data[i + 2] + 50 * a);
  };

  const step = radius < 40 ? 1.2 : 0.4;
  for (let t = 0; t < 360; t += step) {
    const rad = (t * Math.PI) / 180;
    set(Math.round(cx + Math.cos(rad) * radius), Math.round(cy + Math.sin(rad) * radius), 0.55);
  }
  const gap = Math.max(2, Math.round(tick * 0.35));
  for (let d = -tick; d <= tick; d++) {
    if (Math.abs(d) < gap) continue;
    set(Math.round(cx + d), Math.round(cy), 0.8);
    set(Math.round(cx), Math.round(cy + d), 0.8);
  }
}
