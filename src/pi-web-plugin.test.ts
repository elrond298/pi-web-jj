// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginRuntimeContext, Workspace, WorkspaceBackend, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "./browser/pi-web-plugin.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const jjWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/repo",
  label: "default",
  isMain: true,
  provider: { pluginId: "jj", capabilities: { request: true, remove: false } },
};

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("Jujutsu browser plugin", () => {
  it("contributes provider-owned actions and a panel that Git keeps for its own workspaces", async () => {
    const contributions = activate("jj");
    const panel = requiredPanel(contributions);
    const backend = backendFixture();
    const context = panelContext(backend.request);

    expect(panel.id).toBe("workspace.jj");
    expect(panel.title).toBe("Jujutsu");
    expect(panel.order).toBe(20);
    expect(panel.icon).toBeDefined();
    expect(panel.routeAliases).toEqual(["jj", "jujutsu"]);
    expect(panel.visible?.(context)).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...jjWorkspace,
      provider: { pluginId: "git", capabilities: { request: true, remove: false } },
    }))).toBe(false);

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(context));
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });
    const goToJj = contributions.actions?.find((action) => action.id === "view.jj");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-jj");

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.jj", "workspace.refresh-jj"]);
    expect(goToJj?.enabled?.(runtime)).toBe(true);
    await goToJj?.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("jj:workspace.jj");

    await refresh?.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("jj:workspace.jj");
    expect(backend.request).toHaveBeenCalledWith("status", null);
  });

  it("uses source identity for ownership and runtime identity for federated routes", async () => {
    const runtimePluginId = "machine.72656d6f74652d31.jj";
    const contributions = activate("jj", runtimePluginId);
    const panel = requiredPanel(contributions);
    const context = panelContext(backendFixture().request);

    expect(panel.visible?.(context)).toBe(true);

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    await contributions.actions?.find((candidate) => candidate.id === "view.jj")?.run(runtimeContext({ selectMainView }));
    expect(selectMainView).toHaveBeenCalledWith(`${runtimePluginId}:workspace.jj`);
  });

  it("renders the working-copy change, changed files, and the selected diff", async () => {
    const backend = backendFixture({
      files: [
        { path: "src/main.ts", status: "modified" },
        { path: "added file [1].ts", status: "added" },
      ],
      description: "rework the panel",
    });
    const panel = requiredPanel(activate("jj"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);

    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(container.textContent).toContain("abc12345 · rework the panel");
    expect(container.textContent).toContain("src/main.ts");
    expect(container.textContent).toContain("added file [1].ts");
    expect(container.textContent).toContain("Select a changed file.");

    button(container, "added file [1].ts").click();
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("diff", { path: "added file [1].ts" });
    expect(container.textContent).toContain("second line");
    expect(container.querySelectorAll(".jj-diff-cell.add").length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="Unified diff"]')).not.toBeNull();

    // The file disappears from status, so the stale selection and its diff go too.
    backend.status.files = [{ path: "src/main.ts", status: "modified" }];
    await panel.onInvalidate?.(context);
    render(panel.render(context), container);

    expect(container.textContent).toContain("Select a changed file.");
    expect(container.textContent).not.toContain("second line");
  });

  it("reports an actionable error without a paired backend", async () => {
    const panel = requiredPanel(activate("jj"));
    const context = panelContext(undefined);
    const container = document.createElement("div");

    expect(panel.visible?.(context)).toBe(true);
    await panel.onInvalidate?.(context);
    render(panel.render(context), container);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Jujutsu workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser.",
    );
  });

  it("reports a workspace that is no longer a Jujutsu workspace", async () => {
    const backend = backendFixture({ isJjRepo: false });
    const panel = requiredPanel(activate("jj"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);

    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(container.textContent).toContain("Not a Jujutsu workspace.");
  });

  it("polls while the panel is connected and stops after disconnect", async () => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("jj"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);

    render(panel.render(context), container);
    await settleBackend();
    const afterConnect = backend.request.mock.calls.filter(([operation]) => operation === "status").length;
    expect(afterConnect).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await settleBackend();
    expect(backend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(2);

    render(null, container);
    await settleBackend();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(backend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(2);
  });
});

function activate(pluginId: string, runtimePluginId = pluginId) {
  return plugin.activate({ apiVersion: 2, pluginId, runtimePluginId, html, svg }).contributions;
}

function requiredPanel(contributions: ReturnType<typeof activate>) {
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected Jujutsu workspace panel");
  return panel;
}

function backendFixture(
  patch: { files?: { path: string; status: string }[]; isJjRepo?: boolean; description?: string } = {},
) {
  const status = {
    isJjRepo: patch.isJjRepo ?? true,
    change: { changeId: "abc12345", commitId: "def67890", description: patch.description ?? "" },
    files: patch.files ?? [{ path: "src/main.ts", status: "modified" }],
    truncated: false,
  };
  const request = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
    if (operation === "status") return Promise.resolve({ ...status, change: { ...status.change }, files: status.files.map((file) => ({ ...file })) });
    const path = isRecord(input) && typeof input["path"] === "string" ? input["path"] : "diff";
    return Promise.resolve({
      path,
      diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n first line\n+second line\n`,
      truncated: false,
    });
  });
  return { request, status };
}

function panelContext(
  request: WorkspaceBackend["request"] | undefined,
  workspace = jjWorkspace,
  machineId = "local",
): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "jj:workspace.jj", mainView: "jj:workspace.jj" },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    ...(request === undefined ? {} : { backend: { request } }),
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: { selectedWorkspace: jjWorkspace, workspaceTool: "jj:workspace.jj", mainView: "jj:workspace.jj" },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().includes(text));
  if (found === undefined) throw new Error(`Expected button ${text}; rendered text: ${container.textContent ?? ""}`);
  return found;
}

async function settleBackend(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
