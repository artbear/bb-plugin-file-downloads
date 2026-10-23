import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { zipSync } from "fflate";
import { downloadInputSchema, MAX_DOWNLOAD_BYTES, type DownloadInput, type DownloadOutput } from "./shared";

type Sdk = BbPluginApi["sdk"];
// A narrow public-SDK port keeps tests independent of the BB runtime/database.
export type DownloadSdk = {
  files: Pick<Sdk["files"], "read">;
  hosts: Pick<Sdk["hosts"], "get">;
  threads: Pick<Sdk["threads"], "get" | "storageLocation">;
  environments: Pick<Sdk["environments"], "get">;
  projects: Pick<Sdk["projects"], "get">;
};

function pathApi(path: string) {
  return /^[a-z]:/i.test(path) || path.startsWith("\\\\") ? win32 : posix;
}
function validatePath(path: string, relative: boolean, api: typeof posix) {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Путь содержит недопустимые символы.");
  const parts = path.split(api === win32 ? /[\\/]/ : /\//);
  if (parts.includes("..")) throw new Error("Переход через .. запрещён.");
  if (relative && (api.isAbsolute(path) || (api === win32 && /^[a-z]:/i.test(path)))) {
    throw new Error("Для этого источника требуется относительный путь.");
  }
  const basename = api.basename(path);
  if (!basename || basename === "." || basename === ".." || parts.at(-1) === "" || (api === win32 && basename.includes(":"))) {
    throw new Error("Не удалось определить безопасное имя файла.");
  }
  return basename;
}
function scopedPath(rootPath: string, path: string) {
  const api = pathApi(rootPath);
  if (!api.isAbsolute(rootPath)) throw new Error("SDK вернул некорректный корень источника.");
  validatePath(path, true, api);
  const resolved = api.resolve(rootPath, path);
  const relative = api.relative(rootPath, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
    throw new Error("Путь выходит за границы источника.");
  }
  return resolved;
}

async function resolveLocation(sdk: DownloadSdk, input: DownloadInput) {
  const s = input.source;
  let projectId = s.projectId;
  let environmentId = s.environmentId;
  if (s.threadId) {
    const thread = await sdk.threads.get({ threadId: s.threadId });
    if ((projectId && thread.projectId !== projectId) || (environmentId && thread.environmentId !== environmentId)) {
      throw new Error("Thread не соответствует указанному проекту или окружению.");
    }
    projectId = thread.projectId;
    environmentId ??= thread.environmentId;
  }
  let environment: Awaited<ReturnType<Sdk["environments"]["get"]>> | undefined;
  if (environmentId) {
    environment = await sdk.environments.get({ environmentId });
    if (projectId && environment.projectId !== projectId) throw new Error("Окружение не принадлежит проекту.");
    projectId = environment.projectId;
    if (s.experimental_hostId && s.experimental_hostId !== environment.hostId) throw new Error("Host не соответствует окружению.");
  }
  if (s.kind === "thread-storage") {
    if (!s.threadId) throw new Error("Для хранилища требуется threadId.");
    const location = await sdk.threads.storageLocation({ threadId: s.threadId });
    if (s.experimental_hostId && s.experimental_hostId !== location.hostId) throw new Error("Host не соответствует хранилищу.");
    return { hostId: location.hostId, rootPath: location.storageRootPath, path: scopedPath(location.storageRootPath, input.path) };
  }
  let hostId = environment?.hostId;
  let rootPath = environment?.path;
  if (!environment && projectId) {
    const project = await sdk.projects.get({ projectId });
    const candidates = project.sources.filter((source) => s.experimental_hostId ? source.hostId === s.experimental_hostId : source.isDefault);
    if (candidates.length !== 1) throw new Error("Не удалось однозначно определить источник проекта.");
    hostId = candidates[0].hostId;
    rootPath = candidates[0].path;
  }
  if (!hostId && s.kind === "host" && s.experimental_hostId) {
    const host = await sdk.hosts.get({ hostId: s.experimental_hostId });
    hostId = host.id;
  }
  if (!hostId) throw new Error("Не указан источник, определяющий host файла.");
  if (s.kind === "host") {
    if (!pathApi(input.path).isAbsolute(input.path)) throw new Error("Для host требуется абсолютный путь.");
    return { hostId, path: input.path };
  }
  if (!rootPath) throw new Error("У окружения отсутствует рабочий каталог.");
  return { hostId, rootPath, path: scopedPath(rootPath, input.path) };
}

export async function createDownload(sdk: DownloadSdk, rawInput: DownloadInput): Promise<DownloadOutput> {
  const input = downloadInputSchema.parse(rawInput);
  const location = await resolveLocation(sdk, input);
  const fileName = validatePath(location.path, false, pathApi(location.rootPath ?? location.path));
  const file = await sdk.files.read(location);
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > MAX_DOWNLOAD_BYTES) {
    throw new Error("Файл превышает допустимый размер 8 МиБ или SDK вернул неверный размер.");
  }
  if (!("content" in file)) throw new Error("SDK не вернул содержимое файла.");
  if (file.content.length > MAX_DOWNLOAD_BYTES * 4 / 3 + 4) throw new Error("Ответ SDK превышает допустимый размер.");
  if (file.contentEncoding !== "base64" && file.contentEncoding !== "utf8") throw new Error("SDK вернул неподдерживаемую кодировку.");
  const bytes = Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
  if (file.contentEncoding === "base64" && bytes.toString("base64") !== file.content) {
    throw new Error("SDK вернул некорректный base64.");
  }
  if (bytes.length !== file.sizeBytes || !/^[a-f\d]{64}$/i.test(file.sha256) || createHash("sha256").update(bytes).digest("hex") !== file.sha256.toLowerCase()) {
    throw new Error("Не удалось сохранить исходные байты: размер или SHA-256 не совпадает с SDK.");
  }
  if (input.format === "file") return { fileName, mimeType: "text/markdown", base64: bytes.toString("base64") };
  // Null prototype protects special filenames such as __proto__.
  const entries: Record<string, Uint8Array> = Object.create(null);
  entries[fileName] = bytes;
  const zip = zipSync(entries, { level: 0 });
  return { fileName: `${fileName}.zip`, mimeType: "application/zip", base64: Buffer.from(zip).toString("base64") };
}
