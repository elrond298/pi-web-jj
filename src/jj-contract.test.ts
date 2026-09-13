import { describe, expect, it } from "vitest";
import { parseJjDiffResponse, parseJjStatusResponse } from "./browser/jj-contract.js";

describe("Jujutsu browser backend contract", () => {
  it("parses a change header and file rows from JSON-only backend results", () => {
    expect(parseJjStatusResponse({
      isJjRepo: true,
      change: { changeId: "abc12345", commitId: "def67890", description: "rework the panel" },
      files: [{ path: "src/main.ts", status: "modified" }, { path: "gone.txt", status: "removed" }],
      truncated: false,
    })).toEqual({
      isJjRepo: true,
      change: { changeId: "abc12345", commitId: "def67890", description: "rework the panel" },
      files: [{ path: "src/main.ts", status: "modified" }, { path: "gone.txt", status: "removed" }],
      truncated: false,
    });
  });

  it("accepts a workspace that is not a Jujutsu workspace", () => {
    expect(parseJjStatusResponse({ isJjRepo: false, files: [], truncated: false }))
      .toEqual({ isJjRepo: false, files: [], truncated: false });
  });

  it("parses a diff response with and without a path", () => {
    expect(parseJjDiffResponse({ path: "a.txt", diff: "@@ -1 +1 @@\n-x\n+y", truncated: true }))
      .toEqual({ path: "a.txt", diff: "@@ -1 +1 @@\n-x\n+y", truncated: true });
    expect(parseJjDiffResponse({ diff: "", truncated: false })).toEqual({ diff: "", truncated: false });
  });

  it("rejects malformed responses", () => {
    expect(() => parseJjStatusResponse(null)).toThrow("must be an object");
    expect(() => parseJjStatusResponse({ isJjRepo: true, files: "nope", truncated: false })).toThrow("Expected array field: files");
    expect(() => parseJjStatusResponse({ isJjRepo: true, files: [{ path: "a.txt" }], truncated: false })).toThrow("Expected string field: status");
    expect(() => parseJjStatusResponse({ isJjRepo: true, files: [{ path: "", status: "added" }], truncated: false })).toThrow("must not be empty");
    expect(() => parseJjStatusResponse({ isJjRepo: true, change: { changeId: "a", commitId: "b" }, files: [], truncated: false }))
      .toThrow("Expected string field: description");
    expect(() => parseJjDiffResponse({ diff: "x" })).toThrow("Expected boolean field: truncated");
    expect(() => parseJjDiffResponse({ diff: "x", truncated: false, path: 1 })).toThrow("Expected string field: path");
  });
});
