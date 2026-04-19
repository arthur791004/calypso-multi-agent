// End-to-end test for the shipyard:sandbox push flow.
//
// Layer 1 — backend /api/branches/:id/push endpoint behaviour (via Fastify
//           inject): 404 for unknown branch, 400 for trunk, 400 for
//           missing worktree, dry-run returns the synthetic PR shape
//           without running git/gh.
//
// Layer 2 — the CLI script itself: invokes shipyard:sandbox as a subprocess
//           against a real booted backend (127.0.0.1 on an ephemeral port)
//           with SHIPYARD_PUSH_DRYRUN=1, so we exercise the PATH wiring,
//           curl call, and env-var plumbing exactly as Claude would inside
//           the sandbox — but without touching a real git remote.
//
// Layer 3 — CLAUDE.md injection produces the text that tells Claude to use
//           `shipyard:sandbox push`. This is the context a new chat reads
//           on startup, so it's load-bearing for the automated flow.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Must set DATA_DIR before importing anything that reads config, because
// config.ts captures process.env.DATA_DIR at module-load time.
const tmpDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-test-"));
process.env.DATA_DIR = tmpDataDir;

const state = await import("../src/state.js");
const { registerRoutes } = await import("../src/routes.js");
const { injectTaskIntoClaudeMd, taskFilePath } = await import("../src/tasks.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "sandbox-bin", "shipyard:sandbox");

const REPO_ID = "test-repo";
const BRANCH_ID = "test-branch";

let app: FastifyInstance;
let port: number;
let tmpWorktree: string;

beforeAll(async () => {
  await state.loadState();

  tmpWorktree = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-wt-"));

  const now = Date.now();
  await state.addRepo({
    id: REPO_ID,
    name: "test-repo",
    linkTarget: tmpWorktree,
    repoPath: tmpWorktree,
    worktreesDir: path.dirname(tmpWorktree),
    defaultBranch: "main",
    createdAt: now,
  });

  await state.upsertBranch({
    id: BRANCH_ID,
    name: "feature-x",
    repoId: REPO_ID,
    worktreePath: tmpWorktree,
    port: 4100,
    status: "running",
    createdAt: now,
  });

  // Also seed a branch with no worktree to test the 400 path.
  await state.upsertBranch({
    id: "no-wt-branch",
    name: "no-wt",
    repoId: REPO_ID,
    worktreePath: "",
    port: 4101,
    status: "stopped",
    createdAt: now,
  });

  app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  await fsp.rm(tmpDataDir, { recursive: true, force: true });
  await fsp.rm(tmpWorktree, { recursive: true, force: true });
});

// -------- Layer 1: endpoint behaviour --------

describe("POST /api/branches/:id/push", () => {
  it("returns 404 for unknown branch", async () => {
    const res = await app.inject({ method: "POST", url: "/api/branches/does-not-exist/push" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("rejects trunk with 400", async () => {
    const trunkId = state.trunkBranchId(REPO_ID);
    const res = await app.inject({ method: "POST", url: `/api/branches/${trunkId}/push` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/trunk/);
  });

  it("rejects branch with no worktree", async () => {
    const res = await app.inject({ method: "POST", url: "/api/branches/no-wt-branch/push" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no worktree" });
  });

  it("dry-run returns synthetic PR url without running git/gh", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${BRANCH_ID}/push?dryRun=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.created).toBe(false);
    expect(body.url).toMatch(/^dry-run:/);
  });
});

// -------- Layer 2: CLI subprocess --------

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI_PATH, args, {
      env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe("shipyard:sandbox CLI", () => {
  it("prints usage when no command is given", async () => {
    const { code, stderr } = await runCli([], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage/i);
  });

  it("errors with exit 1 when SHIPYARD_BRANCH_ID is unset", async () => {
    const { code, stderr } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: "",
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/SHIPYARD_BRANCH_ID/);
  });

  it("push (dry-run) calls backend and prints synthetic PR response", async () => {
    const { code, stdout, stderr } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
      SHIPYARD_PUSH_DRYRUN: "1",
    });
    expect(code, `stderr=${stderr}`).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.dryRun).toBe(true);
    expect(body.url).toMatch(/^dry-run:/);
  });

  it("surfaces backend 404 as a non-zero exit", async () => {
    const { code, stdout } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: "does-not-exist",
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
      SHIPYARD_PUSH_DRYRUN: "1",
    });
    expect(code).not.toBe(0);
    // --fail-with-body makes curl still write the response body to stdout
    // (its own "curl: (22)..." message goes to stderr).
    expect(stdout).toMatch(/not found/);
  });

  it("rejects unknown subcommand with exit 2", async () => {
    const { code, stderr } = await runCli(["bogus"], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage/i);
  });
});

// -------- Layer 3: CLAUDE.md injection guides Claude to the CLI --------

describe("injectTaskIntoClaudeMd", () => {
  it("writes a Sandbox-rules section that tells Claude to run shipyard:sandbox push", async () => {
    const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-cmd-"));
    try {
      await injectTaskIntoClaudeMd(worktree, "demo-slug");
      const body = await fsp.readFile(path.join(worktree, "CLAUDE.md"), "utf8");
      expect(body).toMatch(/shipyard:sandbox push/);
      expect(body).toMatch(/Do NOT use `git push` directly/);
      // Points Claude at the per-branch task history file.
      expect(body).toContain(taskFilePath("demo-slug"));
    } finally {
      await fsp.rm(worktree, { recursive: true, force: true });
    }
  });
});
