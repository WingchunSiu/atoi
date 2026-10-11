import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** Runs only in the agent workspace. A local commit alone is not a published artifact. */
export async function verifyArtifact(workspace: string, commit: string, review = false) {
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("An immutable 40-character Git commit is required");
  const git = (args: string[]) =>
    exec("git", args, {
      cwd: workspace,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  await git(["fetch", "--no-tags", "--prune", "origin"]);
  const { stdout: refs } = await git([
    "for-each-ref",
    `--contains=${commit}`,
    "--format=%(refname)",
    "refs/remotes/origin/",
  ]);
  if (!refs.trim())
    throw new Error(
      "The commit is not reachable from a fetched origin branch; push it before submitting a result",
    );
  if (review) {
    const { stdout: head } = await git(["rev-parse", "HEAD"]);
    if (head.trim() !== commit)
      throw new Error(
        "Check out the exact submitted commit and run its tests before approving review",
      );
  }
  return refs.trim().split("\n");
}
