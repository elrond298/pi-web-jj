export const JJ_STATUS_OPERATION = "status";
export const JJ_DIFF_OPERATION = "diff";

export interface JjStatusFile {
  /** Repo-root-relative path of the changed file. */
  path: string;
  /**
   * Jujutsu's own status word for the entry (`added`, `modified`, `removed`,
   * `renamed`, `copied`). Kept as a string so a new Jujutsu status renders as
   * its first letter instead of failing the whole response.
   */
  status: string;
}

export interface JjChangeInfo {
  /** Short change id of the working-copy commit (`@`). */
  changeId: string;
  /** Short commit id of the working-copy commit. */
  commitId: string;
  /** First line of the working-copy change description, empty when unset. */
  description: string;
}

export interface JjStatusResponse {
  /** False when the workspace is no longer a Jujutsu workspace (for example a removed `.jj`). */
  isJjRepo: boolean;
  /** Working-copy change facts. Absent when the workspace is not a Jujutsu workspace. */
  change?: JjChangeInfo;
  files: JjStatusFile[];
  /** The host bounded the command output, so `files` may be incomplete. */
  truncated: boolean;
}

export interface JjDiffResponse {
  path?: string;
  /** Unified diff text produced by `jj diff --git`. */
  diff: string;
  truncated: boolean;
}

export function parseJjStatusResponse(value: unknown): JjStatusResponse {
  const record = requireRecord(value, "Jujutsu status response");
  const change = record["change"] === undefined ? undefined : parseJjChangeInfo(record["change"]);
  const files = requireArray(record, "files").map(parseJjStatusFile);
  return {
    isJjRepo: requireBoolean(record, "isJjRepo"),
    ...(change === undefined ? {} : { change }),
    files,
    truncated: requireBoolean(record, "truncated"),
  };
}

export function parseJjDiffResponse(value: unknown): JjDiffResponse {
  const record = requireRecord(value, "Jujutsu diff response");
  const path = optionalString(record, "path");
  return {
    ...(path === undefined ? {} : { path }),
    diff: requireString(record, "diff"),
    truncated: requireBoolean(record, "truncated"),
  };
}

function parseJjChangeInfo(value: unknown): JjChangeInfo {
  const record = requireRecord(value, "Jujutsu change info");
  return {
    changeId: requireString(record, "changeId"),
    commitId: requireString(record, "commitId"),
    description: requireString(record, "description"),
  };
}

function parseJjStatusFile(value: unknown): JjStatusFile {
  const record = requireRecord(value, "Jujutsu status file");
  const path = requireString(record, "path");
  if (path === "") throw new Error("Jujutsu status file path must not be empty");
  return { path, status: requireString(record, "status") };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Expected array field: ${key}`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}
