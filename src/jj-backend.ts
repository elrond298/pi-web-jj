import type {
  JsonValue,
  ProviderRequestContext,
  ProviderResponse,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  JJ_DIFF_OPERATION,
  JJ_STATUS_OPERATION,
  type JjChangeInfo,
  type JjDiffResponse,
  type JjStatusFile,
  type JjStatusResponse,
} from "./browser/jj-contract.js";

export type { JjDiffResponse, JjStatusResponse } from "./browser/jj-contract.js";

export const JJ_COMMAND_TIMEOUT_MS = 20_000;

/**
 * One `jj log` record for the working-copy commit: a tab-separated change
 * header, then one `<json path>\t<status>` line per changed path. `json()`
 * keeps paths and descriptions parseable regardless of their content, which is
 * why the plain `jj workspace list` / `jj diff --summary` text formats are not
 * used here.
 */
const STATUS_TEMPLATE = 'json(change_id.short(8)) ++ "\\t" ++ json(commit_id.short(8)) ++ "\\t" ++ json(description.first_line()) ++ "\\n" ++ self.diff().files().map(|f| json(f.path()) ++ "\\t" ++ f.status()).join("\\n") ++ "\\n"';

/** One `<json workspace name>\t<json absolute root>` line per workspace. */
export const JJ_WORKSPACE_LIST_TEMPLATE = 'json(name) ++ "\\t" ++ json(root) ++ "\\n"';

export interface JjWorkspaceRecord {
  name: string;
  path: string;
}

/** Dispatch the Jujutsu-owned status/diff schema through the provider's public request seam. */
export async function requestJjBackend(
  activationContext: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<ProviderResponse> {
  if (request.operation === JJ_STATUS_OPERATION) {
    requireNullInput(request.input);
    return statusProviderResponse(await jjStatus(activationContext, request.workspace.path, request.signal));
  }
  if (request.operation === JJ_DIFF_OPERATION) {
    return diffProviderResponse(await jjDiff(activationContext, request.workspace.path, parseDiffInput(request.input), request.signal));
  }
  throw new Error(`Unsupported Jujutsu workspace backend operation: ${request.operation}`);
}

function statusProviderResponse(status: JjStatusResponse): ProviderResponse {
  return {
    isJjRepo: status.isJjRepo,
    ...(status.change === undefined ? {} : {
      change: {
        changeId: status.change.changeId,
        commitId: status.change.commitId,
        description: status.change.description,
      },
    }),
    files: status.files.map((file) => ({ path: file.path, status: file.status })),
    truncated: status.truncated,
  };
}

function diffProviderResponse(diff: JjDiffResponse): ProviderResponse {
  return {
    ...(diff.path === undefined ? {} : { path: diff.path }),
    diff: diff.diff,
    truncated: diff.truncated,
  };
}

/** Working-copy change facts for one workspace. A non-zero `jj log` means the path is no longer a Jujutsu workspace. */
export async function jjStatus(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<JjStatusResponse> {
  const result = await runJj(context, cwd, ["log", "-r", "@", "--no-graph", "-T", STATUS_TEMPLATE], signal);
  if (result.code !== 0) return { isJjRepo: false, files: [], truncated: false };
  const records = parseRecordLines(result.stdout, result.truncated);
  const header = records.shift();
  if (header === undefined) throw new Error("jj log returned no working-copy record");
  return {
    isJjRepo: true,
    change: parseChangeHeader(header),
    files: records.map(parseStatusFileLine),
    truncated: result.truncated,
  };
}

/** Unified diff for one path, or the whole working copy when no path was selected. */
export async function jjDiff(
  context: ServerPluginActivationContext,
  cwd: string,
  options: { path?: string },
  signal: AbortSignal,
): Promise<JjDiffResponse> {
  const args = ["diff", "--git"];
  if (options.path !== undefined && options.path !== "") args.push("--", filesetForPath(options.path));
  const result = await runJj(context, cwd, args, signal);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "jj diff failed");
  return {
    ...(options.path === undefined || options.path === "" ? {} : { path: options.path }),
    diff: result.stdout,
    truncated: result.truncated,
  };
}

/** Workspace root of the Jujutsu workspace containing `cwd`, or undefined when there is none. */
export async function jjRepoRoot(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await runJj(context, cwd, ["root"], signal);
  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root === "" ? undefined : root;
}

/** Every workspace tracked by the repository containing `cwd`, in Jujutsu's own order (default first). */
export async function jjWorkspaces(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<JjWorkspaceRecord[]> {
  const result = await runJj(context, cwd, ["workspace", "list", "-T", JJ_WORKSPACE_LIST_TEMPLATE], signal);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "jj workspace list failed");
  if (result.truncated) throw new Error("jj workspace list exceeded the host output limit");
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map(parseWorkspaceLine);
}

function parseRecordLines(stdout: string, truncated: boolean): string[] {
  const lines = stdout.split("\n");
  // A bounded read can end mid-line, and a half-parsed header or path is worse
  // than an incomplete list that says so.
  if (lines[lines.length - 1] === "") lines.pop();
  else if (truncated) lines.pop();
  // A clean working copy renders an empty files section: a blank line, not an entry.
  return lines.filter((line) => line !== "");
}

function parseChangeHeader(line: string): JjChangeInfo {
  const [changeId, commitId, description, ...rest] = line.split("\t");
  if (changeId === undefined || commitId === undefined || description === undefined || rest.length > 0) {
    throw new Error("jj log returned a malformed working-copy header");
  }
  return {
    changeId: parseJsonString(changeId, "change id"),
    commitId: parseJsonString(commitId, "commit id"),
    description: parseJsonString(description, "description"),
  };
}

function parseStatusFileLine(line: string): JjStatusFile {
  const separator = line.lastIndexOf("\t");
  if (separator < 1) throw new Error("jj log returned a malformed status entry");
  return {
    path: parseJsonString(line.slice(0, separator), "path"),
    status: line.slice(separator + 1),
  };
}

function parseWorkspaceLine(line: string): JjWorkspaceRecord {
  const separator = line.lastIndexOf("\t");
  if (separator < 1) throw new Error("jj workspace list returned a malformed entry");
  return {
    name: parseJsonString(line.slice(0, separator), "workspace name"),
    path: parseJsonString(line.slice(separator + 1), "workspace root"),
  };
}

function parseJsonString(value: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`jj returned an unparsable ${label}`);
  }
  if (typeof parsed !== "string") throw new Error(`jj returned a non-string ${label}`);
  return parsed;
}

/**
 * A quoted repo-root-relative fileset, so a path is matched literally even when
 * it contains fileset syntax (`*`, `[`, spaces) or looks like a `glob:` prefix.
 */
export function filesetForPath(path: string): string {
  if (path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    throw new Error("Jujutsu diff paths must not contain control characters");
  }
  return `root:"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function runJj(
  context: ServerPluginActivationContext,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<JjCommandResult> {
  // `--color=never` also defends a `ui.color = "always"` user config, which
  // would otherwise decorate the template output this backend parses.
  return commandResult(await context.execFile({
    file: "jj",
    args: ["--color=never", ...args],
    cwd,
    timeoutMs: JJ_COMMAND_TIMEOUT_MS,
    signal,
  }), args);
}

interface JjCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function commandResult(result: ServerPluginExecFileResult, args: readonly string[]): JjCommandResult {
  const command = `jj ${args.join(" ")}`;
  if (result.signal !== null) throw new Error(`${command} ended from signal ${result.signal}`);
  if (result.exitCode === null) throw new Error(`${command} ended without an exit code`);
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.stdoutTruncated };
}

function requireNullInput(input: JsonValue): void {
  if (input !== null) throw new Error("Jujutsu status input must be null");
}

function parseDiffInput(input: JsonValue): { path?: string } {
  if (!isRecord(input)) throw new Error("Jujutsu diff input must be an object");
  const unsupported = Object.keys(input).find((key) => key !== "path");
  if (unsupported !== undefined) throw new Error(`Jujutsu diff input contains an unsupported field: ${unsupported}`);
  const path = input["path"];
  if (path === undefined) return {};
  if (typeof path !== "string") throw new Error("Jujutsu diff input path must be a string");
  return path === "" ? {} : { path: normalizeRelativePath(path) };
}

/** Reject absolute and traversing paths before they reach a fileset. */
function normalizeRelativePath(value: string): string {
  if (value === "") throw new Error("Jujutsu diff path must not be empty");
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(value)) throw new Error("Absolute paths are not allowed");
  const parts = value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error("Jujutsu diff path must not be empty");
  if (parts.some((part) => part === "..")) throw new Error("Path traversal is not allowed");
  return parts.join("/");
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
