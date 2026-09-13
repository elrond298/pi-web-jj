import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");

describe("PI WEB plugin package", () => {
  it("declares a machine-specific dual-entry plugin with the server module outside the browser root", async () => {
    const metadata: unknown = JSON.parse(await readFile("package.json", "utf8"));

    expect(metadata).toMatchObject({
      type: "module",
      piWeb: {
        plugins: [{
          id: "jj",
          browserRoot: "dist/browser",
          module: "dist/browser/pi-web-plugin.js",
          serverModule: "dist/server-plugin.js",
          machineSpecific: true,
        }],
      },
    });
  });

  it("keeps every PI WEB import type-only and on the two public entrypoints", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const flattened = (await readFile(file, "utf8")).replace(/\r?\n/g, " ");
      for (const match of flattened.matchAll(/(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gu)) {
        const specifier = match[3];
        if (specifier === undefined || !specifier.startsWith("@jmfederico/pi-web/")) continue;
        const label = relative(sourceRoot, file);
        if (specifier !== "@jmfederico/pi-web/plugin-api" && specifier !== "@jmfederico/pi-web/server-plugin-api") {
          violations.push(`${label}: imports ${specifier}`);
        } else if (match[2] === undefined) {
          violations.push(`${label}: runtime import of ${specifier} (must be import type)`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps browser code free of node and host internals, and server code free of browser APIs", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, file);
      const source = await readFile(file, "utf8");
      const isBrowser = relativePath.startsWith(`browser${sep}`);
      if (isBrowser) {
        if (/from\s+["']node:/u.test(source)) violations.push(`${relativePath}: browser import of a node builtin`);
        if (/["'`]\/?api\//u.test(source)) violations.push(`${relativePath}: direct PI WEB API URL`);
        if (/\bfetch\s*\(/u.test(source)) violations.push(`${relativePath}: direct browser fetch`);
      }
      if (/@jmfederico\/pi-web\/(?:dist|src)\//u.test(source)) violations.push(`${relativePath}: imports unpublished PI WEB internals`);
    }

    expect(violations).toEqual([]);
  });
});


async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testSupport.ts")) files.push(path);
  }
  return files;
}
