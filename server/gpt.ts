import { readCredsKey } from "./creds.ts";

export type GptImageResult = {
  b64: string;
  mime: string;
  apiSize: string;
  model: string;
};

type OpenAiImageResponse = {
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string; code?: string };
};

// gpt-image-1 shut down 2026-10-23. dall-e-3 shut down 2026-05-12 and the
// images endpoint now rejects its response_format field on GPT image models.
const MODELS = ["gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"] as const;

function pickApiSize(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.15) return "1536x1024";
  if (ratio < 0.87) return "1024x1536";
  return "1024x1024";
}

function modelUnavailable(message: string): boolean {
  return /model|access|not.?found|unsupported|shut.?down|deprecated|does not exist/i.test(message);
}

async function imagePayload(item: { b64_json?: string; url?: string } | undefined): Promise<{ b64: string; mime: string }> {
  if (item?.b64_json) return { b64: item.b64_json, mime: "image/png" };
  if (!item?.url) throw new Error("GPT RETURNED NO IMAGE");
  const response = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GPT IMAGE URL HTTP ${response.status}`);
  const header = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
  const mime = header.startsWith("image/") ? header : "image/png";
  const b64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  if (!b64) throw new Error("GPT RETURNED NO IMAGE");
  return { b64, mime };
}

async function requestModel(key: string, prompt: string, model: string, width: number, height: number): Promise<GptImageResult> {
  const apiSize = pickApiSize(width, height);
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: apiSize,
      n: 1,
      quality: "medium",
      output_format: "png",
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const body = (await response.json()) as OpenAiImageResponse;
  if (!response.ok) {
    throw new Error(body.error?.message || `GPT IMAGE HTTP ${response.status}`);
  }
  const image = await imagePayload(body.data?.[0]);
  return { ...image, apiSize, model };
}

export async function generateGptImage(prompt: string, width: number, height: number): Promise<GptImageResult> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("PROMPT EMPTY");
  if (trimmed.length > 8000) throw new Error("PROMPT TOO LONG");

  const key = readCredsKey("stegano");
  const failures: string[] = [];
  for (const model of MODELS) {
    try {
      return await requestModel(key, trimmed, model, width, height);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "GPT IMAGE FAILED";
      failures.push(detail);
      if (!modelUnavailable(detail)) break;
    }
  }
  throw new Error(failures.at(-1) || "GPT IMAGE FAILED");
}
