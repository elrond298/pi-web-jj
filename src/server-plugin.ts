import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  PiWebServerPlugin,
  JsonObject,
  JsonValue,
  ProjectInput,
  ProviderClaim,
  ProviderRemoveContext,
  ProviderRequestContext,
  ProviderWorkspace,
  ServerPluginActivationContext,
  WorkspaceProvider,
  WorkspaceRemovePlan,
} from "@jmfederico/pi-web/server-plugin-api";
import { jjRepoRoot, jjWorkspaces, requestJjBackend } from "./jj-backend.js";

const GIT_PROBE_TIMEOUT_MS = 5_000;

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Jujutsu",
  activate(context) {
    return { workspaceProvider: createJjWorkspaceProvider(context) };
  },
};

export default plugin;

export function createJjWorkspaceProvider(context: ServerPluginActivationContext): WorkspaceProvider {
  const claimColocated = readClaimColocated(context.settings);
  return Object.freeze({
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      const root = await jjRootOrUndefined(context, project.path, signal);
      if (root === undefined) return "pass";
      // A colocated repository is also a Git working tree, so Git could own it
      // too. Jujutsu semantics win by default for anyone who has a `.jj` there;
      // `claimColocated: false` hands those repositories back to Git.
      if (!claimColocated && await isColocatedGitRepo(context, root, signal)) return "pass";
      return "claim";
    },
    async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      const mainRoot = await jjRepoRoot(context, project.path, signal);
      if (mainRoot === undefined) throw new Error("Jujutsu could not resolve the workspace root for this project");
      const mainCanonical = await canonicalPath(mainRoot);
      const workspaces = await jjWorkspaces(context, project.path, signal);
      if (workspaces.length === 0) throw new Error("jj workspace list returned no workspaces");
      return await Promise.all(workspaces.map(async (workspace) => {
        const path = resolve(workspace.path);
        const isMain = await canonicalPath(path) === mainCanonical;
        const storeOwner = await isRepositoryStoreOwner(path);
        const removable = !isMain && !storeOwner && workspace.name !== "default";
        return {
          key: path,
          path,
          label: workspace.name,
          isMain,
          data: { workspaceName: workspace.name, root: path, storeOwner } satisfies JsonObject,
          publicMetadata: { isJjRepo: true, isJjWorkspace: !isMain, workspaceName: workspace.name } satisfies JsonObject,
          ...(removable ? { removal: jjRemovalPresentation(workspace.name, path) } : {}),
        };
      }));
    },
    request: (request: ProviderRequestContext) => requestJjBackend(context, request),
    async prepareRemove({ project, workspace, signal }: ProviderRemoveContext): Promise<WorkspaceRemovePlan> {
      const data = privateData(workspace);
      if (resolve(data.root) !== workspace.path) {
        throw new Error("Jujutsu workspace removal data no longer matches the current workspace path");
      }
      if (data.storeOwner) throw new Error("The repository's main Jujutsu workspace cannot be removed");
      const current = await jjWorkspaces(context, project.path, signal);
      const match = current.find((candidate) => candidate.name === data.workspaceName && resolve(candidate.path) === workspace.path);
      if (match === undefined) throw new Error("Jujutsu workspace is no longer available for removal");
      if (await isRepositoryStoreOwner(workspace.path)) {
        throw new Error("The repository's main Jujutsu workspace cannot be removed");
      }
      return {
        title: `Delete workspace: ${workspace.label}`,
        // `&&` keeps the directory: a forget that fails must not delete files
        // the repository still tracks.
        command: `jj workspace forget ${shellQuote(data.workspaceName)} && rm -rf ${shellQuote(workspace.path)}`,
      };
    },
  });
}

/**
 * `plugins.jj.settings.claimColocated` (default true) decides whether a
 * colocated Jujutsu repository — also a Git working tree — is owned by this
 * provider or left to the fallback Git provider.
 */
function readClaimColocated(settings: JsonObject): boolean {
  const value = settings["claimColocated"];
  return typeof value === "boolean" ? value : true;
}

async function jjRootOrUndefined(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return await jjRepoRoot(context, cwd, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

/** True when the Jujutsu workspace root is itself a Git working tree (a "colocated" repository). */
async function isColocatedGitRepo(
  context: ServerPluginActivationContext,
  root: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const result = await context.execFile({
      file: "git",
      args: ["-C", root, "rev-parse", "--show-toplevel"],
      timeoutMs: GIT_PROBE_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode !== 0) return false;
    return await canonicalPath(result.stdout.trim()) === await canonicalPath(root);
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

/**
 * A Jujutsu workspace whose `.jj/repo` is a directory owns the repository store
 * (the workspace created by `jj git init`), so deleting it would delete the
 * repository. Linked workspaces point at that store through a `.jj/repo` file.
 * An uninspectable workspace is reported as a store owner: guessing wrong here
 * would offer a deletion that destroys the repository.
 */
async function isRepositoryStoreOwner(workspacePath: string): Promise<boolean> {
  try {
    return (await stat(join(workspacePath, ".jj", "repo"))).isDirectory();
  } catch {
    return true;
  }
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = resolve(value);
  return await realpath(resolved).catch(() => resolved);
}

function jjRemovalPresentation(name: string, path: string): NonNullable<ProviderWorkspace["removal"]> {
  return {
    actionLabel: "Delete workspace",
    confirmation: `Delete workspace ${name}?\n\nThis will run jj workspace forget and delete:\n${path}\n\nJujutsu stops tracking the workspace and its working-copy commit becomes unreferenced. The repository store and every other workspace are kept.`,
  };
}

function privateData(workspace: ProviderWorkspace): { workspaceName: string; root: string; storeOwner: boolean } {
  const data = workspace.data;
  if (!isRecord(data)) throw new Error("Jujutsu workspace removal data is unavailable");
  return {
    workspaceName: jsonString(data, "workspaceName"),
    root: jsonString(data, "root"),
    storeOwner: data["storeOwner"] === true,
  };
}

function jsonString(data: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value === "") throw new Error(`Jujutsu workspace ${key} is unavailable`);
  return value;
}

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
