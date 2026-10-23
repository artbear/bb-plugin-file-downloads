import { experimental_saveFile } from "@get-bb/plugin-sdk/app";

export interface DownloadPayload {
  fileName: string;
  mimeType: string;
  base64: string;
}

/** Decode bytes directly, without text decoding or newline normalization. */
export async function saveDownload({ fileName, mimeType, base64 }: DownloadPayload): Promise<void> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  // BB owns the browser/native download and any object URL lifecycle.
  const outcome = await experimental_saveFile({
    fileName,
    blob: new Blob([bytes], { type: mimeType }),
  });
  if (outcome === "failed") throw new Error("BB не смог начать сохранение.");
}
