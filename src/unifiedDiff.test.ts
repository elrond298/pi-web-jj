import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./browser/unifiedDiff.js";

// This renderer is a verbatim copy of the bundled Git panel's parser so the
// Jujutsu panel can show `jj diff --git` output; these cases pin the copy to
// the diff shapes Jujutsu produces.
describe("parseUnifiedDiff (Jujutsu panel copy)", () => {
  it("classifies rename metadata and a new-file hunk with line numbers", () => {
    const lines = parseUnifiedDiff([
      "diff --git a/a.txt b/renamed.txt",
      "rename from a.txt",
      "rename to renamed.txt",
      "index ce01362503..94954abda4 100644",
      "--- a/a.txt",
      "+++ b/renamed.txt",
      "@@ -1,1 +1,2 @@",
      " hello",
      "+world",
      "",
    ].join("\n"));

    expect(lines.map((line) => line.kind)).toEqual([
      "meta", "meta", "meta", "meta", "meta", "meta", "hunk", "context", "add",
    ]);
    expect(lines[6]).toMatchObject({ kind: "hunk", text: "@@ -1,1 +1,2 @@" });
    expect(lines[7]).toMatchObject({ kind: "context", prefix: " ", text: "hello", oldLineNumber: 1, newLineNumber: 1 });
    expect(lines[8]).toMatchObject({ kind: "add", prefix: "+", text: "world", newLineNumber: 2 });
  });

  it("marks the changed words inside a replaced line pair", () => {
    const lines = parseUnifiedDiff("@@ -1 +1 @@\n-old work\n+new work\n");
    const removed = lines.find((line) => line.kind === "remove");
    const added = lines.find((line) => line.kind === "add");

    expect(removed?.spans.map((span) => span.text).join("")).toBe("old work");
    expect(added?.spans.map((span) => span.text).join("")).toBe("new work");
    expect(removed?.spans.some((span) => span.changed)).toBe(true);
    expect(added?.spans.some((span) => span.changed)).toBe(true);
  });

  it("returns no lines for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
