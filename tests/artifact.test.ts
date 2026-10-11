import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { verifyArtifact } from "../src/agent/git.js";
import { initializeGit } from "../src/modal/git.js";

const exec = promisify(execFile);
it("rejects unpushed artifacts and review of a different checked-out commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "atoi-artifact-"));
  const remote = join(root, "origin.git");
  const cwd = join(root, "repo");
  const git = (args: string[]) => exec("git", args, { cwd });
  try {
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["clone", remote, cwd]);
    await git(["config", "user.name", "fixture"]);
    await git(["config", "user.email", "fixture@atoi.invalid"]);
    await writeFile(join(cwd, "parser.js"), "export const parser = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["push", "origin", "HEAD:main"]);
    await writeFile(join(cwd, "parser.js"), "export const parser = 2;\n");
    await git(["commit", "-am", "fix"]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await expect(verifyArtifact(cwd, commit)).rejects.toThrow("not reachable");
    await git(["push", "origin", "HEAD:fix"]);
    expect(await verifyArtifact(cwd, commit)).toContain("refs/remotes/origin/fix");
    await git(["checkout", "--detach", baseline]);
    await expect(verifyArtifact(cwd, commit, true)).rejects.toThrow("exact submitted");
    await git(["checkout", "--detach", commit]);
    await expect(verifyArtifact(cwd, commit, true)).resolves.toContain("refs/remotes/origin/fix");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bootstraps an empty repository and independently reviews its first task-branch commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "atoi-empty-"));
  try {
    const remote = join(root, "origin.git"),
      implementer = join(root, "implementer"),
      reviewer = join(root, "reviewer");
    await exec("git", ["init", "--bare", remote]);
    for (const [id, cwd] of [
      ["implementer", implementer],
      ["reviewer", reviewer],
    ])
      await exec("bash", ["-c", initializeGit, "atoi-init", remote!, id!, "", cwd!]);
    await writeFile(join(implementer, "hello.js"), 'console.log("hello");\n');
    await exec("git", ["add", "."], { cwd: implementer });
    await exec("git", ["commit", "-m", "Build first program"], { cwd: implementer });
    const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: implementer })).stdout.trim();
    await expect(verifyArtifact(implementer, commit)).rejects.toThrow("not reachable");
    await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: implementer });
    await exec("bash", ["-c", initializeGit, "atoi-init", remote, "reviewer", commit, reviewer]);
    await expect(verifyArtifact(reviewer, commit, true)).resolves.toContain(
      "refs/remotes/origin/atoi/implementer",
    );
    expect((await exec(process.execPath, ["hello.js"], { cwd: reviewer })).stdout.trim()).toBe(
      "hello",
    );
    expect((await exec("git", ["ls-remote", remote, "refs/heads/main"])).stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
