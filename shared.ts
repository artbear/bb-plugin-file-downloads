import { z } from "zod";

export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(512);
export const downloadSourceSchema = z.object({
  kind: z.enum(["workspace", "host", "thread-storage"]),
  threadId: id.nullable(),
  environmentId: id.nullable(),
  projectId: id.nullable(),
  experimental_hostId: id.optional(),
}).strict();
export const downloadInputSchema = z.object({
  path: z.string().min(1).max(32768),
  source: downloadSourceSchema,
  format: z.enum(["file", "zip"]),
}).strict();
export const downloadOutputSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string(),
  base64: z.string(),
}).strict();
export type DownloadSource = z.infer<typeof downloadSourceSchema>;
export type DownloadInput = z.infer<typeof downloadInputSchema>;
export type DownloadOutput = z.infer<typeof downloadOutputSchema>;
