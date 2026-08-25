export type CipherInfo = {
  id: string;
  family: string;
  alias: boolean;
};

export type CipherCatalog = {
  version: string;
  groups: { family: string; ciphers: CipherInfo[] }[];
};

const SALTED_B64 = "U2FsdGVkX1";

export function looksLikeOpenssl(text: string): boolean {
  return text.trimStart().startsWith(SALTED_B64);
}

export function estimateWiredBytes(plainBytes: number, keyed: boolean): number {
  if (!keyed) return plainBytes;
  const binary = 16 + plainBytes + 16;
  return Math.ceil(binary / 3) * 4;
}

export async function fetchCiphers(): Promise<CipherCatalog> {
  const response = await fetch("/api/ciphers");
  if (!response.ok) throw new Error("CIPHER CATALOG OFFLINE");
  return (await response.json()) as CipherCatalog;
}

export async function requestGptImage(
  prompt: string,
  width: number,
  height: number,
): Promise<{ b64: string; mime: string; apiSize: string; model: string }> {
  const response = await fetch("/api/gpt-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, width, height }),
  });
  const body = (await response.json()) as {
    b64?: string;
    mime?: string;
    apiSize?: string;
    model?: string;
    error?: string;
  };
  if (!response.ok || !body.b64) {
    throw new Error(body.error || "GPT IMAGE FAILED");
  }
  return {
    b64: body.b64,
    mime: body.mime || "image/png",
    apiSize: body.apiSize || "",
    model: body.model || "gpt-image-1",
  };
}

export async function crypt(op: "encrypt" | "decrypt", cipher: string, key: string, text: string): Promise<string> {
  const response = await fetch("/api/crypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, cipher, key, text }),
  });
  const body = (await response.json()) as { text?: string; error?: string };
  if (!response.ok || typeof body.text !== "string") {
    throw new Error(body.error || "CRYPT FAILED");
  }
  return body.text;
}

export async function cryptRaw(
  op: "encrypt" | "decrypt",
  cipher: string,
  key: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const response = await fetch("/api/crypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, cipher, key, bin: bytesToB64(data) }),
  });
  const body = (await response.json()) as { bin?: string; error?: string };
  if (!response.ok || typeof body.bin !== "string") {
    throw new Error(body.error || "CRYPT FAILED");
  }
  return b64ToBytes(body.bin);
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
