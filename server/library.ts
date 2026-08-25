import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { extract, type BitsPerChannel, type StegConfig } from "../src/stegano.ts";
import { decodePng } from "../src/png.ts";

export type LibraryFolder = "source" | "output";

export type LibraryItem = {
  name: string;
  bytes: number;
  mtime: number;
};

export type SaveResult = {
  name: string;
  skipped: boolean;
};

const ROOT = join(process.cwd(), "images");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTHS: BitsPerChannel[] = [1, 2, 3, 4];

function assertFolder(folder: string): LibraryFolder {
  if (folder !== "source" && folder !== "output") throw new Error("BAD FOLDER");
  return folder;
}

export function safeImageName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "image.png";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "") || "image.png";
  return cleaned.toLowerCase().endsWith(".png") ? cleaned : `${cleaned}.png`;
}

export function folderPath(folder: LibraryFolder): string {
  return join(ROOT, folder);
}

export async function ensureLibrary(): Promise<void> {
  await mkdir(join(ROOT, "source"), { recursive: true });
  await mkdir(join(ROOT, "output"), { recursive: true });
}

function resolvedInFolder(folder: LibraryFolder, name: string): string {
  const dir = resolve(folderPath(folder));
  const path = resolve(dir, safeImageName(name));
  const rel = relative(dir, path);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) throw new Error("BAD PATH");
  return path;
}

function canonicalStem(name: string): string {
  return safeImageName(name).replace(/\.png$/i, "");
}

function isNameAlias(existing: string, requested: string): boolean {
  const req = canonicalStem(requested);
  const got = canonicalStem(existing);
  if (got === req) return true;
  if (!got.startsWith(`${req}-`)) return false;
  return /^\d+$/.test(got.slice(req.length + 1));
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function payloadKey(rgba: Uint8Array, width: number, height: number): string {
  const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raster = { data, width, height };
  for (const bitsPerChannel of BIT_DEPTHS) {
    const config: StegConfig = { bitsPerChannel, channels: { r: true, g: true, b: true } };
    try {
      const payload = extract(raster, config);
      return `${bitsPerChannel}:${sha256(payload)}`;
    } catch {
      continue;
    }
  }
  return "";
}

type Fingerprint = {
  width: number;
  height: number;
  pixels: string;
  payload: string;
};

async function fingerprintPng(png: Buffer): Promise<Fingerprint> {
  const decoded = await decodePng(png);
  return {
    width: decoded.width,
    height: decoded.height,
    pixels: sha256(decoded.rgba),
    payload: payloadKey(decoded.rgba, decoded.width, decoded.height),
  };
}

function sameImage(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.pixels === b.pixels &&
    a.payload === b.payload
  );
}

export async function listLibrary(folder: string): Promise<LibraryItem[]> {
  const dir = folderPath(assertFolder(folder));
  await ensureLibrary();
  const names = await readdir(dir);
  const items: LibraryItem[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (!name.toLowerCase().endsWith(".png")) continue;
    const info = await stat(join(dir, name));
    if (!info.isFile()) continue;
    items.push({ name, bytes: info.size, mtime: info.mtimeMs });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

export async function saveLibrary(folder: string, name: string, png: Buffer): Promise<SaveResult> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("NOT A PNG");
  }
  await ensureLibrary();
  const dest = assertFolder(folder);
  const canonical = safeImageName(name);
  const incoming = await fingerprintPng(png);
  const items = await listLibrary(dest);

  for (const item of items) {
    if (!isNameAlias(item.name, canonical)) continue;
    const existingBuf = await readFile(resolvedInFolder(dest, item.name));
    if (existingBuf.equals(png)) return { name: item.name, skipped: true };
    try {
      const existing = await fingerprintPng(existingBuf);
      if (sameImage(incoming, existing)) return { name: item.name, skipped: true };
    } catch {
      continue;
    }
  }

  await writeFile(resolvedInFolder(dest, canonical), png);
  return { name: canonical, skipped: false };
}

export async function readLibraryFile(folder: string, name: string): Promise<Buffer> {
  return readFile(resolvedInFolder(assertFolder(folder), name));
}

export async function deleteLibraryFile(folder: string, name: string): Promise<void> {
  await unlink(resolvedInFolder(assertFolder(folder), name));
}
