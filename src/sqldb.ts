const MAGIC = new TextEncoder().encode("DDDB\n");
const SQLITE_MAGIC = new TextEncoder().encode("SQLite format 3\0");

function concat(header: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((value, i) => data[i] === value);
}

export function isSqliteBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, SQLITE_MAGIC);
}

function safeName(name: string): string {
  return name.replace(/[\r\n]/g, " ").trim() || "payload.sqlite";
}

function headerBytes(name: string, byteLength: number): Uint8Array {
  return new TextEncoder().encode(`DDDB\n${JSON.stringify({ name: safeName(name), n: byteLength })}\n`);
}

export function packedDbSize(name: string, byteLength: number): number {
  return headerBytes(name, byteLength).length + byteLength;
}

export function packDb(name: string, bytes: Uint8Array): Uint8Array {
  if (!isSqliteBytes(bytes)) throw new Error("NOT A SQLITE DATABASE");
  return concat(headerBytes(name, bytes.length), bytes);
}

export function unpackDb(data: Uint8Array): { name: string; bytes: Uint8Array } | null {
  if (startsWith(data, MAGIC)) {
    const rest = data.subarray(MAGIC.length);
    const nl = rest.indexOf(10);
    if (nl < 0) return null;
    try {
      const meta = JSON.parse(new TextDecoder().decode(rest.subarray(0, nl))) as { name?: string; n?: number };
      if (typeof meta.n !== "number" || !Number.isInteger(meta.n) || meta.n < SQLITE_MAGIC.length) return null;
      const body = rest.subarray(nl + 1, nl + 1 + meta.n);
      if (body.length !== meta.n || !isSqliteBytes(body)) return null;
      return { name: safeName(meta.name ?? ""), bytes: body.slice() };
    } catch {
      return null;
    }
  }
  if (!isSqliteBytes(data)) return null;
  return { name: "payload.sqlite", bytes: data.slice() };
}
