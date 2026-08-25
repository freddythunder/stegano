export type LibraryFolder = "source" | "output";

export type LibraryItem = {
  name: string;
  bytes: number;
  mtime: number;
};

export function libraryFileUrl(folder: LibraryFolder, name: string): string {
  const query = new URLSearchParams({ folder, name });
  return `/api/library/file?${query.toString()}`;
}

export async function listLibrary(folder: LibraryFolder): Promise<LibraryItem[]> {
  const response = await fetch(`/api/library?folder=${encodeURIComponent(folder)}`);
  const body = (await response.json()) as { items?: LibraryItem[]; error?: string };
  if (!response.ok || !body.items) {
    throw new Error(body.error || "LIBRARY LIST FAILED");
  }
  return body.items;
}

export async function saveLibraryPng(
  folder: LibraryFolder,
  name: string,
  blob: Blob,
): Promise<{ name: string; skipped: boolean }> {
  const png = await blobToB64(blob);
  const response = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, name, png }),
  });
  const body = (await response.json()) as { name?: string; skipped?: boolean; error?: string };
  if (!response.ok || !body.name) {
    throw new Error(body.error || "LIBRARY SAVE FAILED");
  }
  return { name: body.name, skipped: Boolean(body.skipped) };
}

export async function deleteLibraryPng(folder: LibraryFolder, name: string): Promise<void> {
  const query = new URLSearchParams({ folder, name });
  const response = await fetch(`/api/library?${query.toString()}`, { method: "DELETE" });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "LIBRARY DELETE FAILED");
  }
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      const comma = data.indexOf(",");
      resolve(comma >= 0 ? data.slice(comma + 1) : data);
    };
    reader.onerror = () => reject(reader.error ?? new Error("READ FAILED"));
    reader.readAsDataURL(blob);
  });
}
