import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInput, ServerPluginActivationContext, ServerPluginExecFileRequest, ServerPluginExecFileResult, ServerPluginLogger } from "@jmfederico/pi-web/server-plugin-api";

/**
 * A Jujutsu identity plus an isolated (empty) user config, so fixtures never
 * read the developer's `~/.config/jj/config.toml` and rename detection stays
 * deterministic.
 */
export const JJ_ENV = Object.fromEntries([
  ...Object.entries(process.env).filter(([key]) => !key.startsWith("JJ_")),
  ["JJ_CONFIG", "/dev/null"],
  ["JJ_USER", "PI WEB Test"],
  ["JJ_EMAIL", "pi-web@example.invalid"],
]);

// Fixtures spawn several real `jj` processes; a loaded CI runner can exceed the
// default 5 s per test.
export const FIXTURE_TEST_TIMEOUT_MS = 30_000;

const created: string[] = [];

export function cleanupJjFixtures(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
}

export function jjAvailable(): boolean {
  try {
    execFileSync("jj", ["--version"], { encoding: "utf8", env: JJ_ENV, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function jj(cwd: string, args: readonly string[]): string {
  return execFileSync("jj", args, { cwd, encoding: "utf8", env: JJ_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

/** Non-colocated repository (`jj git init --no-colocate`): `.jj` with no `.git` beside it. */
export function createJjRepo(label: string): string {
  const repo = temporaryDirectory(label);
  jj(repo, ["git", "init", "--no-colocate", "--quiet"]);
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "a.txt"), "first\n", "utf8");
  writeFileSync(join(repo, "sub", "b.txt"), "nested\n", "utf8");
  return repo;
}

/**
 * Colocated repository: a Jujutsu workspace root that is also a Git working
 * tree. Jujutsu colocates by default (`git.colocate`), so this is the common
 * shape of a Jujutsu repository on a developer machine.
 */
export function createColocatedJjRepo(label: string): string {
  const repo = temporaryDirectory(label);
  jj(repo, ["git", "init", "--quiet"]);
  writeFileSync(join(repo, "a.txt"), "first\n", "utf8");
  return repo;
}

/** Secondary (linked) workspace of `repo`, created at a sibling directory. */
export function createLinkedWorkspace(repo: string, name: string): string {
  const path = `${repo}-${name}`;
  created.push(path);
  jj(repo, ["workspace", "add", "--name", name, path]);
  return path;
}

export function temporaryDirectory(label: string): string {
  // Jujutsu reports canonical workspace roots; on macOS a temp dir under
  // `/var` resolves to `/private/var`, so fixtures compare against the real path.
  const path = realpathSync(mkdtempSync(join(tmpdir(), `pi-web-jj-${label}-`)));
  created.push(path);
  return path;
}

export function project(path: string): ProjectInput {
  return { id: "project-1", name: "Project", path };
}

export function testLogger(): ServerPluginLogger {
  const noop = (): void => { /* no-op */ };
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export function jjActivationContext(
  overrides: Partial<ServerPluginActivationContext> = {},
): ServerPluginActivationContext {
  const base: ServerPluginActivationContext = {
    apiVersion: 1,
    pluginId: "jj",
    packageRoot: "pi-web-jj",
    logger: testLogger(),
    settings: {},
    execFile: createTestExecFile({ env: JJ_ENV }),
    signal: new AbortController().signal,
  };
  return { ...base, ...overrides };
}


/**
 * A small stand-in for the host's bounded command helper: same result shape,
 * spawn with abort-signal and timeout support, no output bounds (fixtures are
 * tiny). Production code must use the execFile supplied on activation.
 */
export function createTestExecFile(options: { env?: NodeJS.ProcessEnv } = {}): ServerPluginActivationContext["execFile"] {
  const baseEnv = options.env ?? process.env;
  return (request: ServerPluginExecFileRequest) => new Promise<ServerPluginExecFileResult>((resolve, reject) => {
    const env = { ...baseEnv, ...request.env };
    for (const key of request.unsetEnv ?? []) delete env[key];
    const child = spawn(request.file, [...(request.args ?? [])], { cwd: request.cwd, env, signal: request.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), request.timeoutMs);
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signalName) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        exitCode,
        signal: signalName,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });
  });
}

export function commandResult(overrides: Partial<ServerPluginExecFileResult> = {}): ServerPluginExecFileResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}
