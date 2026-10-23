import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createFakeSdk, createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createDownload } from "./download-service";
import plugin from "./server";
import { MAX_DOWNLOAD_BYTES, type DownloadInput } from "./shared";

const source = { kind: "workspace", threadId: null, environmentId: "e1", projectId: "p1" } as const;
const input: DownloadInput = { path: "notes/Заметки.md", source, format: "file" };
const original = Buffer.from("\ufeff# Привет\r\nстрока\r\n", "utf8");
function file(bytes = original, contentEncoding: "utf8" | "base64" = "utf8") {
  return { content: bytes.toString(contentEncoding), contentEncoding, sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), path: "/work/notes/Заметки.md" };
}
function fixture(options: { root?: string; read?: () => unknown } = {}) {
  return createFakeSdk({ pluginId: "file-downloads", overrides: {
    files: { read: async () => options.read ? options.read() : file() },
    environments: { get: async () => ({ id: "e1", projectId: "p1", hostId: "remote", path: options.root ?? "/work" }) },
    threads: { get: async () => ({ id: "t1", projectId: "p1", environmentId: "e1" }),
      storageLocation: async () => ({ hostId: "storage-host", storageRootPath: "/storage/t1" }) },
    projects: { get: async () => ({ id: "p1", sources: [{ isDefault: true, hostId: "remote", path: "/project" }] }) },
    hosts: { get: async () => ({ id: "explicit-host" }) },
  } });
}

describe("скачивание исходных байтов", () => {
  it("сохраняет Unicode имя, BOM и CRLF; читает с удалённого host под корнем workspace", async () => {
    const { sdk, harness } = fixture();
    const result = await createDownload(sdk, input);
    expect(result.fileName).toBe("Заметки.md");
    expect(Buffer.from(result.base64, "base64")).toEqual(original);
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "remote", rootPath: "/work", path: "/work/notes/Заметки.md" }]);
  });
  it("ZIP содержит только исходный basename и точные байты", async () => {
    const { sdk } = fixture();
    const result = await createDownload(sdk, { ...input, format: "zip" });
    expect(result.fileName).toBe("Заметки.md.zip");
    const files = unzipSync(Buffer.from(result.base64, "base64"));
    expect(Object.keys(files)).toEqual(["Заметки.md"]);
    expect(Buffer.from(files["Заметки.md"]!)).toEqual(original);
  });
  it("сохраняет binary/base64 включая UTF-16 BOM без перекодировки", async () => {
    const bytes = Buffer.from([255, 254, 65, 0, 13, 0, 10, 0, 0, 255]);
    const { sdk } = fixture({ read: () => file(bytes, "base64") });
    expect(Buffer.from((await createDownload(sdk, input)).base64, "base64")).toEqual(bytes);
  });
  it("читает актуальное содержимое при каждом вызове", async () => {
    let bytes = original;
    const { sdk } = fixture({ read: () => file(bytes) });
    await createDownload(sdk, input);
    bytes = Buffer.from("новая версия\r\n");
    expect(Buffer.from((await createDownload(sdk, input)).base64, "base64")).toEqual(bytes);
  });
  it("поддерживает пустой файл", async () => {
    const { sdk } = fixture({ read: () => file(Buffer.alloc(0)) });
    expect((await createDownload(sdk, input)).base64).toBe("");
  });
  it("сохраняет literal backslash POSIX пути и единственное точное имя ZIP", async () => {
    const { sdk, harness } = fixture();
    const request = { ...input, path: "notes/a\\b.md" };
    expect((await createDownload(sdk, request)).fileName).toBe("a\\b.md");
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "remote", rootPath: "/work", path: "/work/notes/a\\b.md" }]);
    const zip = await createDownload(sdk, { ...request, format: "zip" });
    const entries = unzipSync(Buffer.from(zip.base64, "base64"));
    expect(Object.keys(entries)).toEqual(["a\\b.md"]);
    expect(Buffer.from(entries["a\\b.md"]!)).toEqual(original);
  });
  it("сохраняет basename Windows и передаёт Windows rootPath", async () => {
    const { sdk, harness } = fixture({ root: "C:\\repo" });
    expect((await createDownload(sdk, { ...input, path: "docs\\Заметки.md" })).fileName).toBe("Заметки.md");
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "remote", rootPath: "C:\\repo", path: "C:\\repo\\docs\\Заметки.md" }]);
  });
});

describe("scope источника", () => {
  it.each(["../secret.md", "docs/../secret.md", "/etc/secret.md", "bad\0.md", "docs/"])("отклоняет небезопасный относительный путь %s до чтения", async (path) => {
    const { sdk, harness } = fixture();
    await expect(createDownload(sdk, { ...input, path })).rejects.toThrow();
    expect(harness.callsTo("files.read")).toHaveLength(0);
  });
  it.each(["docs\\..\\secret.md", "C:\\secret.md", "C:secret.md", "\\\\server\\secret.md"])("отклоняет Windows traversal/absolute в Windows workspace %s", async (path) => {
    const { sdk, harness } = fixture({ root: "C:\\repo" });
    await expect(createDownload(sdk, { ...input, path })).rejects.toThrow();
    expect(harness.callsTo("files.read")).toHaveLength(0);
  });
  it("отклоняет project/environment mismatch", async () => {
    const { sdk, harness } = fixture();
    await expect(createDownload(sdk, { ...input, source: { ...source, projectId: "other" } })).rejects.toThrow("проект");
    expect(harness.callsTo("files.read")).toHaveLength(0);
  });
  it("отклоняет thread/environment mismatch", async () => {
    const { sdk } = fixture();
    await expect(createDownload(sdk, { ...input, source: { ...source, threadId: "t1", environmentId: "other" } })).rejects.toThrow("Thread");
  });
  it("отклоняет подмену host окружения", async () => {
    const { sdk } = fixture();
    await expect(createDownload(sdk, { ...input, source: { ...source, experimental_hostId: "other" } })).rejects.toThrow("Host");
  });
  it("использует host и rootPath из storageLocation", async () => {
    const { sdk, harness } = fixture();
    await createDownload(sdk, { ...input, source: { ...source, kind: "thread-storage", threadId: "t1" } });
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "storage-host", rootPath: "/storage/t1", path: "/storage/t1/notes/Заметки.md" }]);
  });
  it("требует threadId для thread-storage", async () => {
    const { sdk } = fixture();
    await expect(createDownload(sdk, { ...input, source: { ...source, kind: "thread-storage" } })).rejects.toThrow("threadId");
  });
  it("читает host absolute через host окружения без root workspace", async () => {
    const { sdk, harness } = fixture();
    await createDownload(sdk, { ...input, path: "/outside/Заметки.md", source: { ...source, kind: "host" } });
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "remote", path: "/outside/Заметки.md" }]);
  });
  it("принимает явно выбранный host без implicit server-local fallback", async () => {
    const { sdk, harness } = fixture();
    await createDownload(sdk, { ...input, path: "C:\\notes\\Заметки.md", source: { kind: "host", threadId: null, environmentId: null, projectId: null, experimental_hostId: "explicit-host" } });
    expect(harness.callsTo("hosts.get")).toHaveLength(1);
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "explicit-host", path: "C:\\notes\\Заметки.md" }]);
  });
  it("не использует server-local host при отсутствующем scope", async () => {
    const { sdk, harness } = fixture();
    await expect(createDownload(sdk, { ...input, path: "/tmp/a.md", source: { kind: "host", threadId: null, projectId: null, environmentId: null } })).rejects.toThrow("host");
    expect(harness.callsTo("files.read")).toHaveLength(0);
  });
  it("разрешает workspace через единственный default project source", async () => {
    const { sdk, harness } = fixture();
    await createDownload(sdk, { ...input, source: { ...source, environmentId: null } });
    expect(harness.callsTo("files.read")[0]).toEqual([{ hostId: "remote", rootPath: "/project", path: "/project/notes/Заметки.md" }]);
  });
});

describe("ошибки и ограничения", () => {
  it.each([
    { sizeBytes: MAX_DOWNLOAD_BYTES + 1 },
    { sizeBytes: original.length - 1 },
    { sha256: "0".repeat(64) },
    { content: "обрезано" },
    { contentEncoding: "base64", content: "%%%" },
    { contentEncoding: "latin1" },
    { sizeBytes: -1 },
  ])("отклоняет некорректные данные SDK %j", async (override) => {
    const { sdk } = fixture({ read: () => ({ ...file(), ...override }) });
    await expect(createDownload(sdk, input)).rejects.toThrow();
  });
  it("отклоняет неполное UTF8 представление бинарных байтов по hash", async () => {
    const raw = Buffer.from([255, 254]);
    const { sdk } = fixture({ read: () => file(raw, "utf8") });
    await expect(createDownload(sdk, input)).rejects.toThrow("SHA-256");
  });
  it("передаёт ошибку missing/offline/permission без другого способа чтения", async () => {
    const { sdk, harness } = fixture({ read: () => { throw new Error("Нет доступа к файлу"); } });
    await expect(createDownload(sdk, input)).rejects.toThrow("Нет доступа");
    expect(harness.callsTo("files.read")).toHaveLength(1);
  });
  it("принимает граничные 8 МиБ без усечения", async () => {
    const bytes = Buffer.alloc(MAX_DOWNLOAD_BYTES, 97);
    const { sdk } = fixture({ read: () => file(bytes) });
    const result = await createDownload(sdk, input);
    expect(Buffer.from(result.base64, "base64").equals(bytes)).toBe(true);
  });
  it("принимает граничные 8 МиБ binary/base64 без переполнения стека", async () => {
    const bytes = Buffer.alloc(MAX_DOWNLOAD_BYTES, 255);
    const { sdk } = fixture({ read: () => file(bytes, "base64") });
    const result = await createDownload(sdk, input);
    expect(Buffer.from(result.base64, "base64").equals(bytes)).toBe(true);
  });
  it("RPC валидирует вход и отдаёт base64 по контракту", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "file-downloads", sdk: {
      environments: { get: async () => ({ id: "e1", projectId: "p1", hostId: "remote", path: "/work" }) },
      files: { read: async () => file() },
    } });
    try {
      plugin(bb);
      const result = await harness.behavior.callRpc("downloads_create", input);
      expect(result).toMatchObject({ fileName: "Заметки.md", base64: original.toString("base64") });
      await expect(harness.behavior.callRpc("downloads_create", { ...input, format: "bad" })).rejects.toThrow();
    } finally { await harness.lifecycle.dispose(); }
  });
});
