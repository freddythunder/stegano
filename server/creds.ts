import { readFileSync } from "node:fs";

const CREDS_PATH = "/home/freddythunder/creds";

export function readCredsKey(section: string): string {
  const text = readFileSync(CREDS_PATH, "utf8");
  const block = text.split(/^\[/m).find((chunk) => chunk.startsWith(`${section}]`));
  if (!block) throw new Error(`NO [${section}] BLOCK IN CREDS`);
  const line = block
    .split("\n")
    .slice(1)
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#") && !row.startsWith("["));
  if (!line) throw new Error(`EMPTY [${section}] KEY`);
  const value = line.includes("=") ? line.slice(line.indexOf("=") + 1).trim() : line;
  return value.replace(/^["']|["']$/g, "");
}
