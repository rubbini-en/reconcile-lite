import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../helpers/cli.js";

const HOOK = path.join(ROOT, ".githooks/pre-push");
const INSTALL = path.join(ROOT, "scripts/install-hooks.sh");

// Ignore the developer's own git config (signing, global hooks, templates).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ZERO = "0000000000000000000000000000000000000000";

// A throwaway repository inside the project (.tmp/ is gitignored).
let repo: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: repo, encoding: "utf8", env: GIT_ENV },
  ).trim();
}

function commit(message: string): string {
  git("commit", "--allow-empty", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

/** Runs the hook the way git does: one "<local ref> <local sha> <remote ref> <remote sha>" line per ref. */
function prePush(lines: string[]) {
  const result = spawnSync("sh", [HOOK, "origin", "git@example.invalid:repo.git"], {
    cwd: repo,
    env: GIT_ENV,
    input: lines.map((line) => `${line}\n`).join(""),
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr };
}

const branch = (sha: string, ref = "refs/heads/main") => `${ref} ${sha} ${ref} ${ZERO}`;

beforeAll(() => {
  mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
  repo = mkdtempSync(path.join(ROOT, ".tmp", "pre-push-"));
  git("init", "--quiet");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("pre-push hook", () => {
  it.each([
    ["[ci]", "feat: add a report column [ci]"],
    ["[skip ci]", "docs: fix a typo [skip ci]"],
    ["a tag in the body", "docs: fix a typo\n\nNo code changes. [skip ci]"],
  ])("allows a tip commit with %s", (_label, message) => {
    expect(prePush([branch(commit(message))]).code).toBe(0);
  });

  it("rejects a tip commit without a tag and names the branch", () => {
    const result = prePush([branch(commit("feat: add a report column"))]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refs/heads/main");
    expect(result.stderr).toContain("[ci]");
    expect(result.stderr).toContain("[skip ci]");
  });

  it.each(["[CI]", "[skip-ci]", "[ci skip]", "ci", "[ci ]"])("rejects the near miss %s", (tag) => {
    expect(prePush([branch(commit(`docs: tweak ${tag}`))]).code).toBe(1);
  });

  it("checks only the tip, not earlier commits in the push", () => {
    commit("chore: untagged work in progress");
    expect(prePush([branch(commit("feat: finish it [ci]"))]).code).toBe(0);
  });

  it("rejects the push when any one of several branches is untagged", () => {
    const tagged = commit("feat: one [ci]");
    const untagged = commit("feat: two");
    const result = prePush([branch(tagged), branch(untagged, "refs/heads/other")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refs/heads/other");
  });

  it("rejects a commit it cannot read", () => {
    const unknown = "1234567890123456789012345678901234567890";
    expect(prePush([branch(unknown)]).code).toBe(1);
  });

  it("allows deleting a remote branch", () => {
    expect(prePush([`(delete) ${ZERO} refs/heads/old ${commit("feat: x [ci]")}`]).code).toBe(0);
  });

  it("allows pushing tags", () => {
    const sha = commit("chore: release");
    expect(prePush([`refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`]).code).toBe(0);
  });
});

describe("install-hooks.sh", () => {
  // The ceiling stops git from finding this project's own repository above .tmp/.
  const install = (cwd: string) =>
    spawnSync("sh", [INSTALL], {
      cwd,
      env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: path.join(ROOT, ".tmp") },
      encoding: "utf8",
    });

  it("points core.hooksPath at .githooks", () => {
    expect(install(repo).status).toBe(0);
    expect(git("config", "--get", "core.hooksPath")).toBe(".githooks");
  });

  it("says so when it replaces another hooks path", () => {
    git("config", "core.hooksPath", "/opt/team-hooks");
    const result = install(repo);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("/opt/team-hooks");
    expect(git("config", "--get", "core.hooksPath")).toBe(".githooks");
  });

  it("does nothing outside a git checkout, so npm install still works", () => {
    const plain = mkdtempSync(path.join(ROOT, ".tmp", "no-git-"));
    try {
      const result = install(plain);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
