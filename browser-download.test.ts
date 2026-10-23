// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { saveDownload } from "./browser-download";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_saveFile: vi.fn() }));
const save = vi.mocked(experimental_saveFile);
beforeEach(() => { save.mockReset(); save.mockResolvedValue("started"); });

it("preserves every byte, BOM, CRLF, Unicode filename and MIME through Blob", async () => {
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0xd0, 0xaf, 13, 10, 0, 255]);
  await saveDownload({ fileName: "План команды.mdown", mimeType: "text/markdown", base64: bytes.toString("base64") });
  const request = save.mock.calls[0]![0];
  expect(request.fileName).toBe("План команды.mdown");
  if (!("blob" in request)) throw new Error("Expected Blob download");
  expect(request.blob.type).toBe("text/markdown");
  expect(Buffer.from(await request.blob.arrayBuffer())).toEqual(bytes);
});

it("preserves binary ZIP bytes without text decoding", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 13, 10]);
  await saveDownload({ fileName: "Архив.md.zip", mimeType: "application/zip", base64: bytes.toString("base64") });
  const request = save.mock.calls[0]![0];
  expect(request.fileName).toBe("Архив.md.zip");
  if (!("blob" in request)) throw new Error("Expected Blob download");
  expect(request.blob.type).toBe("application/zip");
  expect(Buffer.from(await request.blob.arrayBuffer())).toEqual(bytes);
});

it("passes an empty file intact", async () => {
  await saveDownload({ fileName: "empty.md", mimeType: "text/markdown", base64: "" });
  const request = save.mock.calls[0]![0];
  if (!("blob" in request)) throw new Error("Expected Blob download");
  expect(request.blob.size).toBe(0);
});

it("does not start saving corrupt base64", async () => {
  await expect(saveDownload({ fileName: "bad.md", mimeType: "text/markdown", base64: "???" })).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});

it("reports the host failing to start saving", async () => {
  save.mockResolvedValue("failed");
  await expect(saveDownload({ fileName: "file.md", mimeType: "text/markdown", base64: "" })).rejects.toThrow("BB не смог начать сохранение");
});
