import type {
  HtmlTemplateTag,
  JsonValue,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  Workspace,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  JJ_DIFF_OPERATION,
  JJ_STATUS_OPERATION,
  parseJjDiffResponse,
  parseJjStatusResponse,
  type JjDiffResponse,
  type JjStatusResponse,
} from "./jj-contract.js";
import { parseUnifiedDiff, type UnifiedDiffLine, type UnifiedDiffTextSpan } from "./unifiedDiff.js";

const JJ_PANEL_LOCAL_ID = "workspace.jj";
const JJ_POLL_INTERVAL_MS = 15_000;
const activityElementTag = "pi-web-jj-panel-activity";

interface JjDiffView {
  readonly response: JjDiffResponse;
  readonly lines: readonly UnifiedDiffLine[];
}

interface JjWorkspaceUiState {
  context: WorkspacePanelContext;
  status: JjStatusResponse | undefined;
  statusLoading: boolean;
  selectedPath: string | undefined;
  diff: JjDiffView | undefined;
  diffLoading: boolean;
  error: string | undefined;
  statusSequence: number;
  diffSequence: number;
}

export function createJjBrowserContributions(
  sourcePluginId: string,
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${JJ_PANEL_LOCAL_ID}`;
  const controller = new JjUiController(sourcePluginId);
  defineJjPanelActivityElement();
  return {
    actions: createJjActions(panelId, controller),
    workspacePanels: [createJjPanel(html, svg, controller)],
  };
}

class JjUiController {
  // The panel is mounted for one workspace at a time, so one retained state is
  // enough: switching workspace drops the previous one instead of caching it.
  private retainedState: JjWorkspaceUiState | undefined;
  private activeKey: string | undefined;

  constructor(private readonly sourcePluginId: string) {}

  isOwnedWorkspace(workspace: Workspace | undefined): boolean {
    return workspace?.provider?.pluginId === this.sourcePluginId;
  }

  state(context: WorkspacePanelContext): JjWorkspaceUiState {
    const key = workspaceContextKey(context);
    if (this.activeKey !== key || this.retainedState === undefined) {
      this.activeKey = key;
      this.retainedState = {
        context,
        status: undefined,
        statusLoading: false,
        selectedPath: undefined,
        diff: undefined,
        diffLoading: false,
        error: undefined,
        statusSequence: 0,
        diffSequence: 0,
      };
    }
    return this.retainedState;
  }

  connect(context: WorkspacePanelContext): void {
    const state = this.state(context);
    if (state.status === undefined && !state.statusLoading) void this.refresh(context);
    else if (state.selectedPath !== undefined && state.diff === undefined && !state.diffLoading) void this.loadDiff(state, state.selectedPath);
  }

  disconnect(context: WorkspacePanelContext): void {
    if (this.activeKey !== workspaceContextKey(context)) return;
    this.retainedState = undefined;
    this.activeKey = undefined;
  }

  poll(context: WorkspacePanelContext): void {
    if (workspaceContextKey(context) !== this.activeKey) return;
    void this.refresh(context);
  }

  async invalidate(context: WorkspacePanelContext): Promise<void> {
    await this.refresh(context);
  }

  async refresh(context: WorkspacePanelContext): Promise<void> {
    const state = this.state(context);
    if (state.statusLoading) return;
    state.statusLoading = true;
    const sequence = ++state.statusSequence;
    try {
      const response = parseJjStatusResponse(await requestBackend(context, JJ_STATUS_OPERATION, null));
      if (sequence !== state.statusSequence) return;
      const changed = JSON.stringify(state.status) !== JSON.stringify(response);
      state.status = response;
      state.error = undefined;
      if (state.selectedPath !== undefined
        && !response.files.some((file) => file.path === state.selectedPath)) {
        state.selectedPath = undefined;
        state.diff = undefined;
      } else if (changed && state.selectedPath !== undefined && !state.diffLoading) {
        // The snapshot moved while a file stayed selected, so its diff is stale too.
        void this.loadDiff(state, state.selectedPath);
      }
    } catch (error) {
      if (sequence !== state.statusSequence) return;
      state.error = errorMessage(error);
    } finally {
      if (sequence === state.statusSequence) {
        state.statusLoading = false;
        requestRender(state);
      }
    }
  }

  selectFile(context: WorkspacePanelContext, path: string): void {
    const state = this.state(context);
    if (state.selectedPath === path && state.diff !== undefined) return;
    state.selectedPath = path;
    state.diff = undefined;
    requestRender(state);
    void this.loadDiff(state, path);
  }

  private async loadDiff(state: JjWorkspaceUiState, path: string): Promise<void> {
    const sequence = ++state.diffSequence;
    state.diffLoading = true;
    try {
      const response = parseJjDiffResponse(await requestBackend(state.context, JJ_DIFF_OPERATION, { path }));
      if (sequence !== state.diffSequence || state.selectedPath !== path) return;
      state.diff = { response, lines: parseUnifiedDiff(response.diff) };
      state.error = undefined;
    } catch (error) {
      if (sequence !== state.diffSequence) return;
      state.diff = undefined;
      state.error = errorMessage(error);
    } finally {
      if (sequence === state.diffSequence) {
        state.diffLoading = false;
        requestRender(state);
      }
    }
  }
}

function createJjActions(panelId: string, controller: JjUiController): PluginAction[] {
  const hasJjWorkspace = (context: PluginRuntimeContext): boolean => controller.isOwnedWorkspace(context.state.selectedWorkspace);
  return [
    {
      id: "view.jj",
      title: "Go to Jujutsu",
      // No shortcut: the bundled Git panel owns mod+3, and a jj workspace is
      // never a Git-owned workspace, so both must stay reachable.
      group: "Navigation",
      enabled: hasJjWorkspace,
      run: (context) => { context.selectMainView(panelId); },
    },
    {
      id: "workspace.refresh-jj",
      title: "Refresh Jujutsu",
      group: "Workspace",
      enabled: hasJjWorkspace,
      run: (context) => context.refreshWorkspacePanels(panelId),
    },
  ];
}

function createJjPanel(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  controller: JjUiController,
): WorkspacePanelContribution {
  return {
    id: JJ_PANEL_LOCAL_ID,
    title: "Jujutsu",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="2.5"></circle>
        <circle cx="16" cy="16" r="2.5"></circle>
        <path d="m10 10 4 4"></path>
        <path d="M16 6.5v7"></path>
      </svg>
    `,
    // Shares the Git panel's slot: a workspace is owned by exactly one provider.
    order: 20,
    routeAliases: ["jj", "jujutsu"],
    visible: (context) => controller.isOwnedWorkspace(context.workspace),
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderJjPanel(html, controller, context),
  };
}

function renderJjPanel(html: HtmlTemplateTag, controller: JjUiController, context: WorkspacePanelContext) {
  const state = controller.state(context);
  return html`
    <section class="jj-panel">
      <style .textContent=${jjPanelStyles}></style>
      <pi-web-jj-panel-activity .controller=${controller} .context=${context}></pi-web-jj-panel-activity>
      ${renderToolbar(html, controller, context, state)}
      ${state.error === undefined ? null : html`<div class="jj-error" role="alert">${state.error}</div>`}
      ${renderBody(html, controller, context, state)}
    </section>
  `;
}

function renderToolbar(
  html: HtmlTemplateTag,
  controller: JjUiController,
  context: WorkspacePanelContext,
  state: JjWorkspaceUiState,
) {
  const change = state.status?.change;
  return html`
    <div class="jj-toolbar">
      <strong>${context.workspace.label}</strong>
      ${change === undefined ? null : html`<small class="jj-change">${jjSummary(change.changeId, change.description)}</small>`}
      <span class="jj-toolbar-actions">
        ${state.status?.truncated === true ? html`<span class="jj-truncated">truncated</span>` : null}
        <button type="button" ?disabled=${state.statusLoading} @click=${() => { void controller.refresh(context); }}>Refresh</button>
      </span>
    </div>
  `;
}

function renderBody(
  html: HtmlTemplateTag,
  controller: JjUiController,
  context: WorkspacePanelContext,
  state: JjWorkspaceUiState,
) {
  const status = state.status;
  if (status === undefined) return html`<p class="jj-muted">Loading…</p>`;
  if (!status.isJjRepo) return html`<p class="jj-muted">Not a Jujutsu workspace.</p>`;
  if (status.files.length === 0) {
    return html`<p class="jj-muted">No working-copy changes.</p>`;
  }
  return html`
    <div class="jj-split">
      <div class="jj-file-list" role="list">
        ${status.files.map((file) => renderFileRow(html, controller, context, state, file.path, file.status))}
      </div>
      <div class="jj-viewer">${renderDiffViewer(html, state)}</div>
    </div>
  `;
}

function renderFileRow(
  html: HtmlTemplateTag,
  controller: JjUiController,
  context: WorkspacePanelContext,
  state: JjWorkspaceUiState,
  path: string,
  status: string,
) {
  const selected = state.selectedPath === path;
  return html`
    <button
      type="button"
      role="listitem"
      class=${selected ? "jj-row is-selected" : "jj-row"}
      title=${path}
      @click=${() => { controller.selectFile(context, path); }}
    >
      <span class="jj-status">${statusLabel(status)}</span>
      <span class="jj-path">${path}</span>
    </button>
  `;
}

function renderDiffViewer(html: HtmlTemplateTag, state: JjWorkspaceUiState) {
  if (state.selectedPath === undefined) return html`<p class="jj-muted">Select a changed file.</p>`;
  const diff = state.diff;
  if (diff === undefined) return html`<p class="jj-muted">Loading diff…</p>`;
  return html`
    <section class="jj-diff-section">
      <div class="jj-viewer-header">
        <strong>${diff.response.path ?? "diff"}</strong>
        ${diff.response.truncated ? html`<small>truncated</small>` : null}
      </div>
      ${diff.lines.length === 0
        ? html`<p class="jj-muted">No diff.</p>`
        : html`
          <div class="jj-diff-scroller">
            <div class="jj-diff-grid" role="table" aria-label="Unified diff">
              ${diff.lines.map((line) => renderDiffLine(html, line))}
            </div>
          </div>
        `}
    </section>
  `;
}

function renderDiffLine(html: HtmlTemplateTag, line: UnifiedDiffLine) {
  return html`
    <div class="jj-diff-line" role="row">
      <span class=${`jj-diff-cell jj-line-number ${line.kind}`} role="cell">${formatLineNumber(line.oldLineNumber)}</span>
      <span class=${`jj-diff-cell jj-line-number ${line.kind}`} role="cell">${formatLineNumber(line.newLineNumber)}</span>
      <span class=${`jj-diff-cell jj-prefix ${line.kind}`} role="cell">${line.prefix}</span>
      <span class=${`jj-diff-cell jj-content ${line.kind}`} role="cell">${renderDiffSpans(html, line.spans)}</span>
    </div>
  `;
}

function renderDiffSpans(html: HtmlTemplateTag, spans: readonly UnifiedDiffTextSpan[]) {
  return spans.map((span) => html`<span class=${span.changed ? "jj-inline-change" : ""}>${span.text}</span>`);
}

function defineJjPanelActivityElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined" || customElements.get(activityElementTag) !== undefined) return;
  class JjPanelActivityElement extends HTMLElement {
    private controllerValue: JjUiController | undefined;
    private contextValue: WorkspacePanelContext | undefined;
    private pollTimer: number | undefined;

    set controller(value: JjUiController | undefined) {
      if (this.controllerValue === value) return;
      this.controllerValue = value;
      this.restart();
    }

    set context(value: WorkspacePanelContext | undefined) {
      const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
      this.contextValue = value;
      if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.restart();
    }

    connectedCallback(): void {
      this.restart();
    }

    disconnectedCallback(): void {
      if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.disconnect(this.contextValue);
      this.stopTimer();
    }

    private restart(): void {
      this.stopTimer();
      if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
      this.controllerValue.connect(this.contextValue);
      this.pollTimer = window.setInterval(() => {
        if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.poll(this.contextValue);
      }, JJ_POLL_INTERVAL_MS);
    }

    private stopTimer(): void {
      if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
  customElements.define(activityElementTag, JjPanelActivityElement);
}

async function requestBackend(
  context: WorkspacePanelContext,
  operation: string,
  input: JsonValue,
): Promise<JsonValue> {
  if (context.backend === undefined || context.workspace.provider?.capabilities.request === false) {
    throw new Error("Jujutsu workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser.");
  }
  return await context.backend.request(operation, input);
}

function requestRender(state: JjWorkspaceUiState): void {
  state.context.host.requestRender();
}

function jjSummary(changeId: string, description: string): string {
  const text = description === "" ? "(no description)" : description;
  return `${changeId} · ${text}`;
}

/** Jujutsu's status word, rendered as the single letter the CLI itself uses. */
export function statusLabel(status: string): string {
  return status === "" ? "?" : status.slice(0, 1).toUpperCase();
}

function formatLineNumber(lineNumber: number | undefined): string {
  return lineNumber === undefined ? "" : String(lineNumber);
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const jjPanelStyles = `
  .jj-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .jj-panel ${activityElementTag} { display: none; }
  .jj-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  .jj-panel button:disabled { cursor: wait; opacity: .65; }
  .jj-panel small, .jj-panel .jj-muted { color: var(--pi-muted); }
  .jj-panel p { margin: 10px; }
  .jj-panel .jj-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .jj-panel .jj-change { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jj-panel .jj-toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .jj-panel .jj-truncated { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); padding: 1px 6px; font-size: 12px; }
  .jj-panel .jj-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .jj-panel .jj-split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(140px, 34%) minmax(0, 1fr); }
  .jj-panel .jj-file-list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border); padding: 6px; }
  .jj-panel .jj-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px; }
  .jj-panel .jj-row:hover, .jj-panel .jj-row.is-selected { background: var(--pi-selection-bg); }
  .jj-panel .jj-status { color: var(--pi-muted); }
  .jj-panel .jj-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jj-panel .jj-viewer { min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  .jj-panel .jj-diff-section { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .jj-panel .jj-viewer-header { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .jj-panel .jj-viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jj-panel .jj-diff-scroller { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--pi-bg); }
  .jj-panel .jj-diff-grid { display: grid; grid-template-columns: max-content max-content 2ch max-content; width: max-content; min-width: 100%; padding: 6px 0; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  .jj-panel .jj-diff-line { display: contents; }
  .jj-panel .jj-diff-cell { min-height: 1.45em; white-space: pre; }
  .jj-panel .jj-line-number { min-width: 4ch; padding: 0 8px; border-right: 1px solid var(--pi-border-muted); color: var(--pi-dim); text-align: right; user-select: none; }
  .jj-panel .jj-prefix { padding: 0 4px; color: var(--pi-dim); text-align: center; user-select: none; }
  .jj-panel .jj-content { padding: 0 12px 0 4px; }
  .jj-panel .jj-diff-cell.meta, .jj-panel .jj-diff-cell.marker { color: var(--pi-dim); }
  .jj-panel .jj-diff-cell.hunk { background: color-mix(in srgb, var(--pi-accent) 9%, transparent); color: var(--pi-accent); }
  .jj-panel .jj-diff-cell.add { background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
  .jj-panel .jj-diff-cell.remove { background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
  .jj-panel .jj-content.add .jj-inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-success) 36%, transparent); color: var(--pi-text); }
  .jj-panel .jj-content.remove .jj-inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-danger) 36%, transparent); color: var(--pi-text); }
`;
