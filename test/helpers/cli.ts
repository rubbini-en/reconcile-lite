import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { testDatabaseUrl } from "./database.js";

const run = promisify(execFile);
export const ROOT = path.resolve(import.meta.dirname, "../..");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a CLI entry point as a child process against the test database. */
export async function runCli(script: string, args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as CliResult;
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
