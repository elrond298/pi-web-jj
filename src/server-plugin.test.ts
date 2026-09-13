import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { jjWorkspaces, requestJjBackend } from "./jj-backend.js";
import type { ProviderWorkspace, ServerPluginActivationContext, WorkspaceProvider } from "@jmfederico/pi-web/server-plugin-api";
import plugin from "./server-plugin.js";
import {
  FIXTURE_TEST_TIMEOUT_MS,
  JJ_ENV,
  cleanupJjFixtures,
  createColocatedJjRepo,
  createJjRepo,
  createLinkedWorkspace,
  jjActivationContext,
  jjAvailable,
  project,
  temporaryDirectory,
} from "./jj.testSupport.js";

const jjInstalled = jjAvailable();
const LINKED_LABEL = "linked checkout";

afterAll(cleanupJjFixtures);

describe("Jujutsu workspace provider", () => {
  it.skipIf(!jjInstalled)("claims a Jujutsu workspace and passes a folder that is not one", async () => {
    const repo = createJjRepo("claim");
    const plain = temporaryDirectory("plain");
    const provider = await providerFor();

    await expect(provider.probe(project(repo), signal())).resolves.toBe("claim");
    await expect(provider.probe(project(plain), signal())).resolves.toBe("pass");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("claims a colocated repository and lets a machine hand it back to Git", async () => {
    const repo = createColocatedJjRepo("colocated");

    await expect((await providerFor()).probe(project(repo), signal())).resolves.toBe("claim");
    await expect((await providerFor({ claimColocated: false })).probe(project(repo), signal())).resolves.toBe("pass");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("still claims a colocated repository's linked workspace, which Git cannot see", async () => {
    const repo = createColocatedJjRepo("colocated-linked");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);

    await expect((await providerFor({ claimColocated: false })).probe(project(linked), signal())).resolves.toBe("claim");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("lists the registered workspace as main and a linked workspace as removable", async () => {
    const repo = createJjRepo("list");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);
    const provider = await providerFor();

    const [main, second] = await provider.list(project(repo), signal());

    expect(main).toEqual({
      key: repo,
      path: repo,
      label: "default",
      isMain: true,
      data: { workspaceName: "default", root: repo, storeOwner: true },
      publicMetadata: { isJjRepo: true, isJjWorkspace: false, workspaceName: "default" },
    });
    expect(second).toEqual({
      key: linked,
      path: linked,
      label: LINKED_LABEL,
      isMain: false,
      data: { workspaceName: LINKED_LABEL, root: linked, storeOwner: false },
      publicMetadata: { isJjRepo: true, isJjWorkspace: true, workspaceName: LINKED_LABEL },
      removal: {
        actionLabel: "Delete workspace",
        confirmation: `Delete workspace ${LINKED_LABEL}?\n\nThis will run jj workspace forget and delete:\n${linked}\n\nJujutsu stops tracking the workspace and its working-copy commit becomes unreferenced. The repository store and every other workspace are kept.`,
      },
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("keeps the containing workspace as main for a registered subdirectory", async () => {
    const repo = createJjRepo("subdirectory");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);
    const provider = await providerFor();

    const workspaces = await provider.list(project(join(repo, "sub")), signal());

    expect(workspaces.map(({ path, isMain }) => ({ path, isMain }))).toEqual([
      { path: repo, isMain: true },
      { path: linked, isMain: false },
    ]);
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("never offers removal for the repository store owner", async () => {
    const repo = createJjRepo("store-owner");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);
    const provider = await providerFor();

    // The project is registered at the linked workspace, so "default" — the
    // workspace that owns the repository store — is a peer, not the main one.
    const workspaces = await provider.list(project(linked), signal());
    const byLabel = new Map(workspaces.map((workspace) => [workspace.label, workspace]));

    expect(byLabel.get(LINKED_LABEL)).toMatchObject({ isMain: true });
    expect(byLabel.get(LINKED_LABEL)?.removal).toBeUndefined();
    expect(byLabel.get("default")).toMatchObject({ isMain: false });
    expect(byLabel.get("default")?.removal).toBeUndefined();
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("serves status and diffs through the provider request seam", async () => {
    const repo = createJjRepo("backend");
    const provider = await providerFor();

    expect(await provider.probe(project(repo), signal())).toBe("claim");
    const main = (await provider.list(project(repo), signal())).find((candidate) => candidate.isMain);
    if (main === undefined) throw new Error("Expected a main workspace");

    const status = await requestJjBackend(jjActivationContext(), {
      project: project(repo),
      workspace: main,
      operation: "status",
      input: null,
      signal: signal(),
    });
    expect(status).toMatchObject({
      isJjRepo: true,
      files: [{ path: "a.txt", status: "added" }, { path: "sub/b.txt", status: "added" }],
    });

    const diff = await requestJjBackend(jjActivationContext(), {
      project: project(repo),
      workspace: main,
      operation: "diff",
      input: { path: "a.txt" },
      signal: signal(),
    });
    expect(diff).toMatchObject({ path: "a.txt" });
    expect(diffText(diff)).toContain("+first");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("builds a removal plan that forgets and deletes the workspace", async () => {
    const repo = createJjRepo("remove");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);
    const provider = await providerFor();
    const target = await workspaceNamed(provider, repo, LINKED_LABEL);

    const plan = await prepareRemove(provider, { project: project(repo), workspace: target, signal: signal() });

    expect(plan).toEqual({
      title: `Delete workspace: ${LINKED_LABEL}`,
      command: `jj workspace forget '${LINKED_LABEL}' && rm -rf '${linked}'`,
    });
    // The plan's shell source is the contract with the host terminal, so run it
    // for real against a throwaway repository.
    execFileSync("bash", ["-lc", plan.command], { cwd: repo, encoding: "utf8", env: JJ_ENV, stdio: "ignore" });
    await expect(jjWorkspaces(jjActivationContext(), repo, signal())).resolves.toEqual([
      { name: "default", path: repo },
    ]);
    expect(existsSync(linked)).toBe(false);
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("refuses removal for the store owner, for stale data, and for a gone workspace", async () => {
    const repo = createJjRepo("refuse");
    const linked = createLinkedWorkspace(repo, LINKED_LABEL);
    const provider = await providerFor();
    const main = await workspaceNamed(provider, repo, "default");
    const target = await workspaceNamed(provider, repo, LINKED_LABEL);

    await expect(prepareRemove(provider, { project: project(repo), workspace: main, signal: signal() }))
      .rejects.toThrow("main Jujutsu workspace cannot be removed");
    await expect(prepareRemove(provider, {
      project: project(repo),
      workspace: { ...target, path: `${linked}-moved`, data: { workspaceName: LINKED_LABEL, root: linked, storeOwner: false } },
      signal: signal(),
    })).rejects.toThrow("no longer matches the current workspace path");
    await expect(prepareRemove(provider, {
      project: project(repo),
      workspace: { ...target, data: { workspaceName: "forgotten", root: linked, storeOwner: false } },
      signal: signal(),
    })).rejects.toThrow("no longer available for removal");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it("passes when the jj binary is unavailable and propagates an abort", async () => {
    const missing = await providerFor(undefined, () => Promise.reject(new Error("spawn jj ENOENT")));
    await expect(missing.probe(project("/repo"), signal())).resolves.toBe("pass");

    const controller = new AbortController();
    const aborted = await providerFor(undefined, () => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });
    await expect(aborted.probe(project("/repo"), controller.signal)).rejects.toThrow("aborted");
  });
});

async function providerFor(
  settings?: Record<string, boolean>,
  execFile?: ServerPluginActivationContext["execFile"],
): Promise<WorkspaceProvider> {
  const activation = await plugin.activate(jjActivationContext({
    ...(settings === undefined ? {} : { settings }),
    ...(execFile === undefined ? {} : { execFile }),
  }));
  const provider = activation.workspaceProvider;
  if (provider === undefined) throw new Error("Jujutsu plugin did not activate its workspace provider");
  return provider;
}

async function workspaceNamed(provider: WorkspaceProvider, repo: string, label: string): Promise<ProviderWorkspace> {
  const workspaces = await provider.list(project(repo), signal());
  const match = workspaces.find((workspace) => workspace.label === label);
  if (match === undefined) throw new Error(`Expected a workspace labelled ${label}`);
  return match;
}

function prepareRemove(
  provider: WorkspaceProvider,
  context: Parameters<NonNullable<WorkspaceProvider["prepareRemove"]>>[0],
) {
  if (provider.prepareRemove === undefined) throw new Error("Jujutsu provider must plan workspace removal");
  return provider.prepareRemove(context);
}


function signal(): AbortSignal {
  return new AbortController().signal;
}

function diffText(value: unknown): string {
  if (!isRecord(value)) throw new Error("Expected a diff response object");
  const diff = value["diff"];
  if (typeof diff !== "string") throw new Error("Expected a diff string");
  return diff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

