import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CipherInfo = {
  id: string;
  family: string;
  alias: boolean;
};

export type CipherCatalog = {
  version: string;
  groups: { family: string; ciphers: CipherInfo[] }[];
};

const CIPHER_ID = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_TEXT = 1_500_000;
const FAMILY_ORDER = [
  "AES",
  "CHACHA",
  "ARIA",
  "CAMELLIA",
  "SM4",
  "3DES",
  "DES",
  "DESX",
  "BLOWFISH",
  "CAST5",
  "RC2",
  "RC4",
  "SEED",
  "OTHER",
];

const ALIASES = new Set([
  "aes128",
  "aes192",
  "aes256",
  "aria128",
  "aria192",
  "aria256",
  "camellia128",
  "camellia192",
  "camellia256",
  "bf",
  "blowfish",
  "cast",
  "cast-cbc",
  "des",
  "des3",
  "desx",
  "rc2",
  "rc2-128",
  "seed",
  "sm4",
]);

let catalogPromise: Promise<CipherCatalog> | null = null;
let allowed: Set<string> | null = null;

function familyOf(id: string): string {
  if (id.startsWith("aes")) return "AES";
  if (id.startsWith("chacha")) return "CHACHA";
  if (id.startsWith("aria")) return "ARIA";
  if (id.startsWith("camellia")) return "CAMELLIA";
  if (id.startsWith("sm4")) return "SM4";
  if (id.startsWith("des-ede3") || id === "des3") return "3DES";
  if (id.startsWith("desx")) return "DESX";
  if (id.startsWith("des")) return "DES";
  if (id.startsWith("bf") || id === "blowfish") return "BLOWFISH";
  if (id.startsWith("cast")) return "CAST5";
  if (id.startsWith("rc2")) return "RC2";
  if (id.startsWith("rc4")) return "RC4";
  if (id.startsWith("seed")) return "SEED";
  return "OTHER";
}

function parseCipherList(raw: string): string[] {
  const ids = [...raw.matchAll(/-([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => CIPHER_ID.test(id) && !id.includes("wrap") && !id.endsWith("-"));
}

export async function loadCatalog(): Promise<CipherCatalog> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const [{ stdout: verOut }, { stdout: listOut }] = await Promise.all([
      execFileAsync("openssl", ["version"]),
      execFileAsync("openssl", ["enc", "-ciphers"]),
    ]);
    const ids = parseCipherList(listOut);
    allowed = new Set(ids);
    const grouped = new Map<string, CipherInfo[]>();
    for (const id of ids) {
      const info: CipherInfo = { id, family: familyOf(id), alias: ALIASES.has(id) };
      const list = grouped.get(info.family) ?? [];
      list.push(info);
      grouped.set(info.family, list);
    }
    const groups = FAMILY_ORDER.filter((family) => grouped.has(family)).map((family) => ({
      family,
      ciphers: (grouped.get(family) ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    }));
    return { version: verOut.trim(), groups };
  })();
  return catalogPromise;
}

function runOpenssl(args: string[], input: Buffer, envExtra: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, {
      env: { ...process.env, ...envExtra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const err = Buffer.concat(stderr).toString("utf8").trim() || `openssl exited ${code}`;
      reject(new Error(err.split("\n")[0]));
    });
    child.stdin.end(input);
  });
}

export async function crypt(
  op: "encrypt" | "decrypt",
  cipher: string,
  key: string,
  input: Uint8Array,
): Promise<Uint8Array> {
  await loadCatalog();
  if (!allowed?.has(cipher) || !CIPHER_ID.test(cipher)) {
    throw new Error("CIPHER NOT AVAILABLE");
  }
  if (!key) throw new Error("KEY REQUIRED");
  if (key.length > 1024) throw new Error("KEY TOO LONG");
  if (input.length > MAX_TEXT) throw new Error("TEXT TOO LONG");

  const token = `DD_PASS_${randomBytes(8).toString("hex")}`;
  const args = [
    "enc",
    `-${cipher}`,
    op === "encrypt" ? "-e" : "-d",
    "-a",
    "-A",
    "-pbkdf2",
    "-iter",
    "10000",
    "-pass",
    `env:${token}`,
    "-provider",
    "legacy",
    "-provider",
    "default",
  ];

  const output = await runOpenssl(args, Buffer.from(input), { [token]: key });
  if (op === "decrypt" && output.length === 0 && input.length > 0) {
    throw new Error("DECRYPT PRODUCED EMPTY OUTPUT");
  }
  return new Uint8Array(output);
}
