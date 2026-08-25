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

function pickApiSize(width: number, height: number, model: "gpt-image-1" | "dall-e-3"): string {
  const ratio = width / height;
  if (model === "dall-e-3") {
    if (ratio > 1.15) return "1792x1024";
    if (ratio < 0.87) return "1024x1792";
    return "1024x1024";
  }
  if (ratio > 1.15) return "1536x1024";
  if (ratio < 0.87) return "1024x1536";
  return "1024x1024";
}

async function requestModel(
  key: string,
  prompt: string,
  model: "gpt-image-1" | "dall-e-3",
  width: number,
  height: number,
): Promise<GptImageResult> {
  const apiSize = pickApiSize(width, height, model);
  const payload: Record<string, unknown> = {
    model,
    prompt,
    size: apiSize,
    n: 1,
  };
  if (model === "gpt-image-1") payload.quality = "medium";
  else payload.response_format = "b64_json";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });

  const body = (await response.json()) as OpenAiImageResponse;
  if (!response.ok) {
    throw new Error(body.error?.message || `GPT IMAGE HTTP ${response.status}`);
  }
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("GPT RETURNED NO IMAGE");
  return { b64, mime: "image/png", apiSize, model };
}

export async function generateGptImage(prompt: string, width: number, height: number): Promise<GptImageResult> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("PROMPT EMPTY");
  if (trimmed.length > 8000) throw new Error("PROMPT TOO LONG");

  const key = readCredsKey("stegano");
  try {
    return await requestModel(key, trimmed, "gpt-image-1", width, height);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (!/model|access|not.?found|unsupported/i.test(detail)) throw error;
    return await requestModel(key, trimmed, "dall-e-3", width, height);
  }
}
