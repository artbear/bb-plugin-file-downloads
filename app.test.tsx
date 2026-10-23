// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginFileOpenerProps, PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { experimental_saveFile } from "@get-bb/plugin-sdk/app";
import type { DownloadPayload } from "./browser-download";

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
  experimental_saveFile: vi.fn(),
}));

const app = await loadPluginApp(() => import("./app"));
const registration = app.fileOpeners[0]!;
const source: PluginFileOpenerSource = {
  kind: "workspace", threadId: "thread-1", environmentId: "env-1",
  projectId: "project-1", experimental_hostId: "host-1",
};
const payload: DownloadPayload = {
  fileName: "Заметка с пробелами.md", mimeType: "text/markdown", base64: "Iw0K",
};
const props: PluginFileOpenerProps = {
  path: "docs/Заметка с пробелами.md", source,
  Original: () => <div>Встроенный просмотр Markdown</div>,
};
const save = vi.mocked(experimental_saveFile);
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { save.mockReset(); save.mockResolvedValue("started"); });
afterEach(cleanup);

describe("Markdown file opener", () => {
  it("registers only the requested extensions and retains Original", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.fileOpeners).toHaveLength(1);
    expect(registration).toMatchObject({ id: "markdown-downloads",
      title: "Markdown со скачиванием", extensions: ["md", "markdown", "mdown"] });
    const view = renderSlot(registration, props);
    expect(view.getByText("Встроенный просмотр Markdown")).toBeTruthy();
    expect(view.getByRole("button", { name: "Скачать файл" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Скачать ZIP" })).toBeTruthy();
  });

  it.each(["file", "zip"] as const)("sends the exact source and saves %s with the server filename", async (format) => {
    const result = { ...payload, ...(format === "zip"
      ? { fileName: "Заметка с пробелами.zip", mimeType: "application/zip" } : {}) };
    const handler = vi.fn().mockResolvedValue(result);
    const view = renderSlot(registration, props, { rpc: { downloads_create: handler } });
    fireEvent.click(view.getByRole("button", { name: format === "zip" ? "Скачать ZIP" : "Скачать файл" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({ path: props.path, source, format });
    const request = save.mock.calls[0]![0];
    expect(request.fileName).toBe(result.fileName);
    expect("blob" in request).toBe(true);
    if (!("blob" in request)) throw new Error("Expected Blob download");
    expect(request.blob.type).toBe(result.mimeType);
    expect(request.blob.size).toBe(3);
    expect(view.getByText("Встроенный просмотр Markdown")).toBeTruthy();
    await waitFor(() => expect((view.getByRole("button", { name: "Скачать файл" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("blocks both buttons synchronously until the save has started", async () => {
    const pending = deferred<DownloadPayload>();
    const saving = deferred<"started">();
    save.mockReturnValue(saving.promise);
    const handler = vi.fn().mockReturnValue(pending.promise);
    const view = renderSlot(registration, props, { rpc: { downloads_create: handler } });
    const file = view.getByRole("button", { name: "Скачать файл" }) as HTMLButtonElement;
    const zip = view.getByRole("button", { name: "Скачать ZIP" }) as HTMLButtonElement;
    act(() => { file.click(); file.click(); zip.click(); });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(file.disabled).toBe(true);
    expect(zip.disabled).toBe(true);
    expect(view.getByRole("status").textContent).toContain("Подготовка файла");
    await act(async () => { pending.resolve(payload); });
    expect(file.disabled).toBe(true);
    await act(async () => { saving.resolve("started"); });
    expect(file.disabled).toBe(false);
  });

  it("shows an RPC error, keeps Original, and permits retry", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("Нет доступа")).mockResolvedValue(payload);
    const view = renderSlot(registration, props, { rpc: { downloads_create: handler } });
    fireEvent.click(view.getByRole("button", { name: "Скачать файл" }));
    expect((await view.findByRole("alert")).textContent).toContain("Нет доступа");
    expect(save).not.toHaveBeenCalled();
    expect(view.getByText("Встроенный просмотр Markdown")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Скачать ZIP" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("shows a save-start failure", async () => {
    save.mockResolvedValue("failed");
    const view = renderSlot(registration, props, { rpc: { downloads_create: () => payload } });
    fireEvent.click(view.getByRole("button", { name: "Скачать файл" }));
    expect((await view.findByRole("alert")).textContent).toContain("BB не смог начать сохранение");
  });

  it.each(["path", "source", "unmount"] as const)("ignores stale completion after %s changes", async (change) => {
    const pending = deferred<DownloadPayload>();
    const view = renderSlot(registration, props, { rpc: { downloads_create: () => pending.promise } });
    fireEvent.click(view.getByRole("button", { name: "Скачать файл" }));
    const Opener = registration.component;
    if (change === "unmount") view.lifecycle.unmount();
    else view.lifecycle.rerender(<Opener {...props}
      path={change === "path" ? "other.md" : props.path}
      source={change === "source" ? { ...source, experimental_hostId: "host-2" } : source} />);
    await act(async () => { pending.resolve(payload); });
    expect(save).not.toHaveBeenCalled();
    if (change !== "unmount") {
      expect((view.getByRole("button", { name: "Скачать файл" }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("does not remount Original or cancel download for an identical source and new line target", async () => {
    const mounted = vi.fn();
    // A state initializer is called only on an actual Original mount.
    const { useState } = await import("react");
    const Original = () => { useState(() => mounted()); return <div>Original</div>; };
    const pending = deferred<DownloadPayload>();
    const view = renderSlot(registration, { ...props, Original }, { rpc: { downloads_create: () => pending.promise } });
    fireEvent.click(view.getByRole("button", { name: "Скачать файл" }));
    const Opener = registration.component;
    view.lifecycle.rerender(<Opener {...props} Original={Original} source={{ ...source }}
      experimental_lineRange={{ startLineNumber: 3, endLineNumber: 4 }} />);
    await act(async () => { pending.resolve(payload); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
