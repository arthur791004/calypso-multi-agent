import fs from "node:fs/promises";
import path from "node:path";
import { run, runOrThrow } from "./shell.js";
import { getSettings } from "./state.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectDefaultBranch(gitPath: string): Promise<string> {
  const head = await run("git", ["-C", gitPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, "");
    if (name) return name;
  }
  const cur = await run("git", ["-C", gitPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur.code === 0) {
    const name = cur.stdout.trim();
    if (name && name !== "HEAD") return name;
  }
  return "trunk";
}

export async function ensureRepo(): Promise<string> {
  const { repoPath, repoUrl } = getSettings();
  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  if (await exists(path.join(repoPath, ".git"))) {
    return repoPath;
  }
  await runOrThrow("git", ["clone", "--branch", "trunk", repoUrl, repoPath]);
  return repoPath;
}

export async function createWorktree(folderName: string, branch: string, base?: string): Promise<string> {
  const { repoPath, worktreesDir } = getSettings();
  await ensureRepo();
  await fs.mkdir(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, folderName);

  const localCheck = await run("git", ["-C", repoPath, "rev-parse", "--verify", branch]);
  if (localCheck.code === 0) {
    await runOrThrow("git", ["-C", repoPath, "worktree", "add", worktreePath, branch]);
    return worktreePath;
  }

  await run("git", ["-C", repoPath, "fetch", "origin", branch]);
  const remoteCheck = await run("git", [
    "-C",
    repoPath,
    "rev-parse",
    "--verify",
    `origin/${branch}`,
  ]);
  if (remoteCheck.code === 0) {
    await runOrThrow("git", [
      "-C",
      repoPath,
      "worktree",
      "add",
      "-B",
      branch,
      worktreePath,
      `origin/${branch}`,
    ]);
    return worktreePath;
  }

  const args = ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath];
  if (base) args.push(base);
  await runOrThrow("git", args);
  return worktreePath;
}

export async function listGitBranches(): Promise<string[]> {
  const { repoPath } = getSettings();
  const res = await run("git", [
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  const { repoPath } = getSettings();
  await run("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
}

export async function deleteBranch(branch: string): Promise<void> {
  const { repoPath } = getSettings();
  await run("git", ["-C", repoPath, "branch", "-D", branch]);
}
