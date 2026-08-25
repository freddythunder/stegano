import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { crypt, loadCatalog } from "./openssl.ts";
import { generateGptImage } from "./gpt.ts";
import {
  deleteLibraryFile,
  ensureLibrary,
  listLibrary,
  readLibraryFile,
  saveLibrary,
} from "./library.ts";

type CryptBody = {
  op?: string;
  cipher?: string;
  key?: string;
  text?: string;
  bin?: string;
};

type GptBody = {
  prompt?: string;
  width?: number;
  height?: number;
};

type LibraryBody = {
  folder?: string;
  name?: string;
  png?: string;
};

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("BODY TOO LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

function failMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/ciphers" && req.method === "GET") {
    try {
      send(res, 200, await loadCatalog());
    } catch (error) {
      send(res, 500, { error: failMessage(error, "OPENSSL UNAVAILABLE") });
    }
    return true;
  }

  if (path === "/api/crypt" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 40_000_000)) || "{}") as CryptBody;
      if (body.op !== "encrypt" && body.op !== "decrypt") {
        send(res, 400, { error: "op must be encrypt|decrypt" });
        return true;
      }
      const input = body.bin
        ? new Uint8Array(Buffer.from(body.bin, "base64"))
        : new TextEncoder().encode(body.text ?? "");
      const output = await crypt(body.op, body.cipher ?? "", body.key ?? "", input);
      if (body.bin !== undefined) {
        send(res, 200, { bin: Buffer.from(output).toString("base64") });
      } else {
        send(res, 200, { text: new TextDecoder("utf-8", { fatal: false }).decode(output) });
      }
    } catch (error) {
      send(res, 400, { error: failMessage(error, "CRYPT FAILED") });
    }
    return true;
  }

  if (path === "/api/gpt-image" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 100_000)) || "{}") as GptBody;
      const result = await generateGptImage(body.prompt ?? "", Number(body.width) || 1024, Number(body.height) || 1024);
      send(res, 200, result);
    } catch (error) {
      send(res, 400, { error: failMessage(error, "GPT IMAGE FAILED") });
    }
    return true;
  }

  if (path === "/api/library" && req.method === "GET") {
    try {
      send(res, 200, { items: await listLibrary(url.searchParams.get("folder") ?? "source") });
    } catch (error) {
      send(res, 400, { error: failMessage(error, "LIBRARY LIST FAILED") });
    }
    return true;
  }

  if (path === "/api/library/file" && req.method === "GET") {
    try {
      const buf = await readLibraryFile(url.searchParams.get("folder") ?? "", url.searchParams.get("name") ?? "");
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } catch (error) {
      send(res, 404, { error: failMessage(error, "NOT FOUND") });
    }
    return true;
  }

  if (path === "/api/library" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 40_000_000)) || "{}") as LibraryBody;
      const png = Buffer.from(body.png ?? "", "base64");
      const result = await saveLibrary(body.folder ?? "", body.name ?? "image.png", png);
      send(res, 200, result);
    } catch (error) {
      send(res, 400, { error: failMessage(error, "LIBRARY SAVE FAILED") });
    }
    return true;
  }

  if (path === "/api/library" && req.method === "DELETE") {
    try {
      await deleteLibraryFile(url.searchParams.get("folder") ?? "", url.searchParams.get("name") ?? "");
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 400, { error: failMessage(error, "LIBRARY DELETE FAILED") });
    }
    return true;
  }

  return false;
}

function ignoreOrphanPipeErrors(): void {
  const tagged = process as NodeJS.Process & { __ddPipeGuard?: boolean };
  if (tagged.__ddPipeGuard) return;
  tagged.__ddPipeGuard = true;
  process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ECONNRESET") {
      console.warn("[dead-drop] ignored orphan pipe:", error.message);
      return;
    }
    console.error(error);
    process.exit(1);
  });
}

export function opensslLab(): Plugin {
  return {
    name: "openssl-lab",
    configureServer(server) {
      ignoreOrphanPipeErrors();
      void ensureLibrary();
      server.middlewares.use((req, res, next) => {
        void handle(req, res).then((hit) => {
          if (!hit) next();
        }, next);
      });
    },
    configurePreviewServer(server) {
      ignoreOrphanPipeErrors();
      void ensureLibrary();
      server.middlewares.use((req, res, next) => {
        void handle(req, res).then((hit) => {
          if (!hit) next();
        }, next);
      });
    },
  };
}
