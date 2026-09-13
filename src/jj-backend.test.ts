import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ServerPluginActivationContext } from "@jmfederico/pi-web/server-plugin-api";
import { jjDiff, jjRepoRoot, jjStatus, jjWorkspaces, requestJjBackend, filesetForPath } from "./jj-backend.js";
import {
  FIXTURE_TEST_TIMEOUT_MS,
  cleanupJjFixtures,
  commandResult,
  createJjRepo,
  createLinkedWorkspace,
  jj,
  jjActivationContext,
  jjAvailable,
  temporaryDirectory,
} from "./jj.testSupport.js";

const jjInstalled = jjAvailable();

afterAll(cleanupJjFixtures);

describe("Jujutsu backend", () => {
  it.skipIf(!jjInstalled)("reports the working-copy change and every changed path", async () => {
    const repo = createJjRepo("status");
    jj(repo, ["commit", "-m", "base"]);
    renameSync(join(repo, "a.txt"), join(repo, "renamed.txt"));
    rmSync(join(repo, "sub", "b.txt"));
    writeFileSync(join(repo, "new file [1]*.txt"), "added\n", "utf8");

    const status = await jjStatus(jjActivationContext(), repo, new AbortController().signal);

    expect(status.isJjRepo).toBe(true);
    expect(status.truncated).toBe(false);
    expect(status.change?.changeId).toMatch(/[a-z]/u);
    expect(status.change?.commitId).toMatch(/[0-9a-f]/u);
    expect(status.change?.description).toBe("");
    expect(status.files).toEqual([
      { path: "new file [1]*.txt", status: "added" },
      { path: "renamed.txt", status: "renamed" },
      { path: "sub/b.txt", status: "removed" },
    ]);
  }, FIXTURE_TEST_TIMEOUT_MS);


  it.skipIf(!jjInstalled)("parses a clean working copy whose files section renders as a blank line", async () => {
    const repo = createJjRepo("clean");
    jj(repo, ["commit", "-m", "base"]);

    const status = await jjStatus(jjActivationContext(), repo, new AbortController().signal);

    expect(status.isJjRepo).toBe(true);
    expect(status.files).toEqual([]);
  }, FIXTURE_TEST_TIMEOUT_MS);
  it.skipIf(!jjInstalled)("reports a non-Jujutsu directory instead of failing", async () => {
    const directory = temporaryDirectory("plain");

    await expect(jjStatus(jjActivationContext(), directory, new AbortController().signal))
      .resolves.toEqual({ isJjRepo: false, files: [], truncated: false });
    await expect(jjRepoRoot(jjActivationContext(), directory, new AbortController().signal)).resolves.toBeUndefined();
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("quotes a changed path so fileset syntax is matched literally", async () => {
    const repo = createJjRepo("fileset");
    writeFileSync(join(repo, "weird name [1]*.txt"), "hello\n", "utf8");

    const diff = await jjDiff(jjActivationContext(), repo, { path: "weird name [1]*.txt" }, new AbortController().signal);

    expect(diff.path).toBe("weird name [1]*.txt");
    expect(diff.diff).toContain("diff --git a/weird name [1]*.txt b/weird name [1]*.txt");
    expect(diff.diff).toContain("+hello");
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("diffs a renamed path and the whole working copy", async () => {
    const repo = createJjRepo("rename");
    jj(repo, ["commit", "-m", "base"]);
    renameSync(join(repo, "a.txt"), join(repo, "renamed.txt"));

    const fileDiff = await jjDiff(jjActivationContext(), repo, { path: "renamed.txt" }, new AbortController().signal);
    const allDiff = await jjDiff(jjActivationContext(), repo, {}, new AbortController().signal);

    expect(fileDiff.diff).toContain("rename from a.txt");
    expect(fileDiff.diff).toContain("rename to renamed.txt");
    expect(allDiff.path).toBeUndefined();
    expect(allDiff.diff).toBe(fileDiff.diff);
  }, FIXTURE_TEST_TIMEOUT_MS);

  it.skipIf(!jjInstalled)("lists every workspace with an absolute root", async () => {
    const repo = createJjRepo("workspaces");
    const linked = createLinkedWorkspace(repo, "linked");

    const workspaces = await jjWorkspaces(jjActivationContext(), repo, new AbortController().signal);

    expect(workspaces).toEqual([
      { name: "default", path: repo },
      { name: "linked", path: linked },
    ]);
  }, FIXTURE_TEST_TIMEOUT_MS);

  it("rejects malformed requests before running a command", async () => {
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>();
    const context = jjActivationContext({ execFile });
    const request = {
      project: { id: "project-1", name: "Project", path: "/repo" },
      workspace: { key: "/repo", path: "/repo", label: "default", isMain: true },
      signal: new AbortController().signal,
    };

    await expect(requestJjBackend(context, { ...request, operation: "log", input: null }))
      .rejects.toThrow("Unsupported Jujutsu workspace backend operation: log");
    await expect(requestJjBackend(context, { ...request, operation: "status", input: {} }))
      .rejects.toThrow("Jujutsu status input must be null");
    await expect(requestJjBackend(context, { ...request, operation: "diff", input: { path: "/etc/passwd" } }))
      .rejects.toThrow("Absolute paths are not allowed");
    await expect(requestJjBackend(context, { ...request, operation: "diff", input: { path: "../../secret" } }))
      .rejects.toThrow("Path traversal is not allowed");
    await expect(requestJjBackend(context, { ...request, operation: "diff", input: { staged: true } }))
      .rejects.toThrow("Jujutsu diff input contains an unsupported field: staged");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("drops a partial trailing row when the host bounded the output", async () => {
    const context = jjActivationContext({
      execFile: () => Promise.resolve(commandResult({
        stdout: '"abc12345"\t"def67890"\t"message"\n"a.txt"\tmodified\n"b.txt"\tmod',
        stdoutTruncated: true,
      })),
    });

    const status = await jjStatus(context, "/repo", new AbortController().signal);

    expect(status).toEqual({
      isJjRepo: true,
      change: { changeId: "abc12345", commitId: "def67890", description: "message" },
      files: [{ path: "a.txt", status: "modified" }],
      truncated: true,
    });
  });

  it("surfaces a malformed header as an error instead of a bogus status", async () => {
    const misplaced = jjActivationContext({
      execFile: () => Promise.resolve(commandResult({ stdout: "not json\teither\n" })),
    });
    const unparsable = jjActivationContext({
      execFile: () => Promise.resolve(commandResult({ stdout: "not-json\t\"abc12345\"\t\"description\"\n" })),
    });

    await expect(jjStatus(misplaced, "/repo", new AbortController().signal)).rejects.toThrow("malformed working-copy header");
    await expect(jjStatus(unparsable, "/repo", new AbortController().signal)).rejects.toThrow("unparsable change id");
  });
});

describe("filesetForPath", () => {
  it("pins a path to the repo root and escapes quotes and backslashes", () => {
    expect(filesetForPath("src/main.ts")).toBe('root:"src/main.ts"');
    expect(filesetForPath('odd "quoted" \\ path.txt')).toBe('root:"odd \\"quoted\\" \\\\ path.txt"');
    expect(() => filesetForPath("broken\npath")).toThrow("control characters");
  });
});

// Keep the fixture helper honest: a directory with no `.jj` must never look like a workspace root.
it.skipIf(!jjInstalled)("does not treat a nested plain directory as a root", async () => {
  const repo = createJjRepo("nested");
  const nested = join(repo, "sub");
  mkdirSync(join(nested, "deeper"));

  await expect(jjRepoRoot(jjActivationContext(), nested, new AbortController().signal)).resolves.toBe(repo);
}, FIXTURE_TEST_TIMEOUT_MS);
