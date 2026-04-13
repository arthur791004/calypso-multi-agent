import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import path from "node:path";
import { deriveRepoPaths } from "./config.js";
import { ensureDashboardRunning, isPortOpen, stopDashboard, waitForDashboard } from "./dashboard.js";
import {
  Branch,
  TRUNK_ID,
  allocatePort,
  getActiveBranchId,
  getBranch,
  getSettings,
  listBranches,
  removeBranch,
  setActiveBranchId,
  updateBranch,
  updateSettings,
  upsertBranch,
} from "./state.js";
import { createWorktree, deleteBranch as deleteGitBranch, detectDefaultBranch, ensureRepo, listGitBranches, removeWorktree } from "./worktree.js";
import { run, runOrThrow } from "./shell.js";
import {
  createSandbox,
  removeSandbox,
  sandboxLogs,
  sandboxName,
  startSandbox,
  stopSandbox,
} from "./docker.js";

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
  );
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    const settings = getSettings();
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let repoExists = false;
    try {
      await fs.access(path.join(settings.repoPath, ".git"));
      repoExists = true;
    } catch {}
    let repoLinkTarget: string | undefined;
    try {
      const lstat = await fs.lstat(settings.repoPath);
      if (lstat.isSymbolicLink()) {
        repoLinkTarget = await fs.readlink(settings.repoPath);
      }
    } catch {}
    return { ...settings, repoExists, repoLinkTarget };
  });

  app.put<{ Body: Partial<{ repoUrl: string; repoPath: string; worktreesDir: string; configured: boolean; linkTarget: string; dashboardInstallCmd: string; dashboardStartCmd: string }> }>(
    "/api/settings",
    async (req, reply) => {
      const { linkTarget, ...patch } = req.body ?? {};
      let derived: ReturnType<typeof deriveRepoPaths> | undefined;
      let defaultBranch: string | undefined;
      if (linkTarget) {
        const repoName = path.basename(linkTarget.replace(/\/+$/, "")) || "repo";
        defaultBranch = await detectDefaultBranch(linkTarget);
        derived = deriveRepoPaths(repoName, defaultBranch);
      }
      const next = await updateSettings({
        ...patch,
        ...(derived ?? {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        configured: true,
      });
      if (derived) {
        await updateBranch(TRUNK_ID, { worktreePath: next.repoPath }).catch(() => {});
      }
      if (linkTarget) {
        try {
          const fs = await import("node:fs/promises");
          await fs.mkdir(path.dirname(next.repoPath), { recursive: true });
          try {
            const stat = await fs.lstat(next.repoPath);
            if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
              await fs.rm(next.repoPath, { recursive: true, force: true });
            }
          } catch {}
          await fs.symlink(linkTarget, next.repoPath);
        } catch (err: any) {
          return reply.code(500).send({ error: `Failed to symlink repo: ${err.message}`, settings: next });
        }
      } else {
        try {
          await ensureRepo();
        } catch (err: any) {
          return reply.code(500).send({ error: `Failed to clone repo: ${err.message}`, settings: next });
        }
      }
      return next;
    }
  );

  app.post("/api/pick-folder", async (_req, reply) => {
    try {
      const res = await run("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select Calypso repo folder")',
      ]);
      if (res.code !== 0) return reply.code(204).send();
      const raw = res.stdout.trim();
      const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
      return { path };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? "pick-folder failed" });
    }
  });

  app.get("/api/branches", async () => {
    const stateBranches = listBranches();
    const takenNames = new Set(stateBranches.map((b) => b.name));
    const localGit = await listGitBranches();
    const stubs: Branch[] = localGit
      .filter((n) => !takenNames.has(n))
      .map((name) => ({
        id: `git:${name}`,
        name,
        worktreePath: "",
        port: 0,
        status: "stopped",
        createdAt: 1,
      }));
    const merged = [...stateBranches, ...stubs].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.name.localeCompare(b.name);
    });
    const baseBranch = getSettings().defaultBranch || "trunk";
    const enriched = await Promise.all(
      merged.map(async (b) => {
        if (b.id === TRUNK_ID || !b.worktreePath) return { ...b, hasChanges: false };
        const res = await run("git", [
          "-C",
          b.worktreePath,
          "rev-list",
          "--count",
          `${baseBranch}..${b.name}`,
        ]);
        const count = res.code === 0 ? parseInt(res.stdout.trim(), 10) || 0 : 0;
        return { ...b, hasChanges: count > 0 };
      })
    );
    return { branches: enriched, activeBranchId: getActiveBranchId() };
  });

  app.get("/api/git-branches", async () => ({ branches: await listGitBranches() }));

  app.post<{ Body: { name: string; base?: string } }>(
    "/api/branches",
    async (req, reply) => {
      const { name, base } = req.body ?? ({} as any);
      if (!name) return reply.code(400).send({ error: "name required" });

      const id = randomUUID().slice(0, 8);
      const slug = slugify(name) || id;
      const port = allocatePort();

      const branch: Branch = {
        id,
        name: slug,
        worktreePath: "",
        port,
        status: "creating",
        createdAt: Date.now(),
      };
      await upsertBranch(branch);

      try {
        const worktreePath = await createWorktree(slug, slug, base);
        const sbName = sandboxName(slug);
        await createSandbox(sbName, worktreePath);
        await startSandbox(sbName, worktreePath, port);
        await updateBranch(id, { worktreePath, sandboxName: sbName, status: "running" });
      } catch (err: any) {
        await updateBranch(id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }

      return getBranch(id);
    }
  );

  app.post<{ Params: { id: string } }>("/api/branches/:id/toggle", async (req, reply) => {
    let branch = getBranch(req.params.id);

    if (!branch && req.params.id.startsWith("git:")) {
      const gitName = req.params.id.slice(4);
      const id = randomUUID().slice(0, 8);
      const port = allocatePort();
      const created: Branch = {
        id,
        name: gitName,
        worktreePath: "",
        port,
        status: "creating",
        createdAt: Date.now(),
      };
      await upsertBranch(created);
      try {
        const worktreePath = await createWorktree(gitName, gitName);
        const sbName = sandboxName(gitName);
        await createSandbox(sbName, worktreePath);
        await startSandbox(sbName, worktreePath, port);
        await updateBranch(id, { worktreePath, sandboxName: sbName, status: "running" });
      } catch (err: any) {
        await updateBranch(id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }
      return getBranch(id);
    }

    if (!branch) return reply.code(404).send({ error: "not found" });

    if (branch.id === TRUNK_ID) {
      if (branch.status === "running") {
        stopDashboard(branch.worktreePath);
        await updateBranch(branch.id, { status: "stopped" });
        return getBranch(branch.id);
      }
      try {
        await ensureDashboardRunning(branch.worktreePath, branch.port);
        await updateBranch(branch.id, { status: "running", error: undefined });
        return getBranch(branch.id);
      } catch (err: any) {
        await updateBranch(branch.id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }
    }

    if (!branch.sandboxName) return reply.code(400).send({ error: "no sandbox" });

    if (branch.status === "running") {
      await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
      await updateBranch(branch.id, { status: "stopped" });
      return getBranch(branch.id);
    }

    try {
      await startSandbox(branch.sandboxName, branch.worktreePath, branch.port);
      await updateBranch(branch.id, { status: "running", error: undefined });
      return getBranch(branch.id);
    } catch (err: any) {
      await updateBranch(branch.id, { status: "error", error: err.message });
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/open-editor", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });
    try {
      const fs = await import("node:fs/promises");
      let target = branch.worktreePath;
      try {
        target = await fs.realpath(branch.worktreePath);
      } catch {}
      await runOrThrow("/bin/sh", ["-lc", `code "${target}"`]);
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: `failed to open editor: ${err.message}` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/create-pr", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (branch.id === TRUNK_ID) return reply.code(400).send({ error: "cannot create PR for trunk" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });

    try {
      await runOrThrow("git", ["push", "-u", "origin", branch.name], { cwd: branch.worktreePath });
    } catch (err: any) {
      return reply.code(500).send({ error: `git push failed: ${err.message}` });
    }

    const existing = await run("gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
      cwd: branch.worktreePath,
    });
    if (existing.code === 0 && existing.stdout.trim()) {
      const url = existing.stdout.trim();
      await updateBranch(branch.id, { prUrl: url });
      return { url };
    }

    try {
      const url = (await runOrThrow("gh", ["pr", "create", "--fill"], { cwd: branch.worktreePath })).trim();
      await updateBranch(branch.id, { prUrl: url });
      return { url };
    } catch (err: any) {
      return reply.code(500).send({ error: `gh pr create failed: ${err.message}` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/start-dashboard", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });
    if (await isPortOpen(branch.port)) return { running: true };

    await ensureDashboardRunning(branch.worktreePath, branch.port);
    if (await waitForDashboard(branch.port)) return { running: true };
    return reply.code(504).send({ error: "dashboard did not come up within 15 minutes" });
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/switch", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    await setActiveBranchId(branch.id);
    return { activeBranchId: branch.id };
  });

  app.get<{ Params: { id: string } }>("/api/branches/:id/logs", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.sandboxName) return { logs: "" };
    return { logs: await sandboxLogs(branch.sandboxName) };
  });

  app.delete<{ Params: { id: string } }>("/api/branches/:id", async (req, reply) => {
    if (req.params.id.startsWith("git:")) {
      const name = req.params.id.slice(4);
      try {
        await runOrThrow("git", ["-C", getSettings().repoPath, "branch", "-D", name]);
        return { ok: true };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (branch.id === TRUNK_ID) return reply.code(400).send({ error: "trunk cannot be deleted" });
    if (branch.sandboxName) {
      await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
      await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
    }
    if (branch.worktreePath) await removeWorktree(branch.worktreePath).catch(() => {});
    if (branch.name) await deleteGitBranch(branch.name).catch(() => {});
    await removeBranch(branch.id);
    return { ok: true };
  });
}
