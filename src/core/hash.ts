import type { Hash } from "./types";

export async function sha256(data: Uint8Array): Promise<Hash> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
