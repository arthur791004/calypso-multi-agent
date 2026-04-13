import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pty, { IPty } from "node-pty";
import { run, runOrThrow } from "./shell.js";
import { config } from "./config.js";
import { ensureDashboardRunning, stopDashboard } from "./dashboard.js";

let cachedDockerPath: string | null = null;

export function resolveDockerPath(): string {
  if (cachedDockerPath) return cachedDockerPath;
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return (cachedDockerPath = c);
  }
  try {
    const out = execFileSync("/bin/sh", ["-lc", "command -v docker"], {
      encoding: "utf8",
    }).trim();
    if (out) return (cachedDockerPath = out);
  } catch {}
  return (cachedDockerPath = "docker");
}

interface SandboxPty {
  term: IPty;
  buffer: string;
  subscribers: Set<(data: string) => void>;
}

const runningPtys = new Map<string, SandboxPty>();

const SCROLLBACK_LIMIT = 100_000;

export function attachSandbox(
  name: string,
  onData: (data: string) => void
): { unsubscribe: () => void; write: (data: string) => void; resize: (cols: number, rows: number) => void } | null {
  const entry = runningPtys.get(name);
  if (!entry) return null;
  if (entry.buffer) onData(entry.buffer);
  entry.subscribers.add(onData);
  return {
    unsubscribe: () => entry.subscribers.delete(onData),
    write: (data: string) => entry.term.write(data),
    resize: (cols: number, rows: number) => {
      try { entry.term.resize(cols, rows); } catch {}
    },
  };
}

export function sandboxName(slug: string): string {
  return `claude-${slug}`;
}

export async function sandboxExists(name: string): Promise<boolean> {
  const res = await run("docker", ["sandbox", "ls"]);
  return res.stdout.split("\n").some((l) => l.trim().split(/\s+/)[0] === name);
}

export async function createSandbox(name: string, worktreePath: string): Promise<void> {
  if (await sandboxExists(name)) return;
  await fsp.mkdir(config.claudeSandboxDir, { recursive: true });
  const mounts = [worktreePath, config.claudeSandboxDir];
  const mainRepoPath = await resolveMainRepoPath(worktreePath);
  if (mainRepoPath && !mounts.includes(mainRepoPath)) mounts.push(mainRepoPath);
  await runOrThrow("docker", [
    "sandbox",
    "create",
    "--name",
    name,
    config.dockerImage,
    ...mounts,
  ]);
}

async function resolveMainRepoPath(worktreePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(worktreePath, ".git"), "utf8");
    const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gitDir = m[1];
    const idx = gitDir.indexOf("/.git/");
    if (idx === -1) return null;
    return await fsp.realpath(gitDir.slice(0, idx));
  } catch {
    return null;
  }
}

const MOUNT_CREDS = `${config.claudeSandboxDir}/.credentials.json`;
const AGENT_CREDS = "/home/agent/.claude/.credentials.json";
const MOUNT_CONFIG = `${config.claudeSandboxDir}/.claude.json`;
const AGENT_CONFIG = "/home/agent/.claude.json";

export async function syncCredentialsIn(name: string): Promise<void> {
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    `mkdir -p /home/agent/.claude && rm -rf ${AGENT_CREDS} && if [ -f ${MOUNT_CREDS} ]; then cp -f ${MOUNT_CREDS} ${AGENT_CREDS} && chmod 600 ${AGENT_CREDS}; fi`,
  ]);
}

async function buildMinimalClaudeConfig(worktreePath?: string): Promise<string> {
  const projectEntry = worktreePath
    ? {
        [worktreePath]: {
          allowedTools: [],
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 1,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
        },
      }
    : {};
  try {
    const raw = await fsp.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
    const full = JSON.parse(raw);
    const minimal = {
      hasCompletedOnboarding: true,
      oauthAccount: full.oauthAccount,
      userID: full.userID,
      anonymousId: full.anonymousId,
      installMethod: full.installMethod ?? "sandbox",
      numStartups: 1,
      effortCalloutDismissed: true,
      effortCalloutV2Dismissed: true,
      hasShownOpus45Notice: full.hasShownOpus45Notice,
      hasShownOpus46Notice: full.hasShownOpus46Notice,
      lastReleaseNotesSeen: full.lastReleaseNotesSeen,
      lastOnboardingVersion: full.lastOnboardingVersion,
      projects: projectEntry,
    };
    return JSON.stringify(minimal);
  } catch {
    return JSON.stringify({ hasCompletedOnboarding: true, projects: projectEntry });
  }
}

export async function syncClaudeConfigIn(name: string, worktreePath?: string): Promise<void> {
  if (await fileExists(config.claudeSandboxDir + "/.claude.json")) {
    await runOrThrow(resolveDockerPath(), [
      "sandbox",
      "exec",
      name,
      "sh",
      "-c",
      `cp -f ${MOUNT_CONFIG} ${AGENT_CONFIG} && chmod 600 ${AGENT_CONFIG}`,
    ]);
    return;
  }
  const minimal = await buildMinimalClaudeConfig(worktreePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      resolveDockerPath(),
      [
        "sandbox",
        "exec",
        "-i",
        name,
        "sh",
        "-c",
        `cat > ${AGENT_CONFIG} && chmod 600 ${AGENT_CONFIG}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`syncClaudeConfigIn exit ${code}: ${stderr}`))
    );
    child.stdin.write(minimal);
    child.stdin.end();
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function syncCredentialsOut(name: string): Promise<void> {
  if ((await getSandboxStatus(name)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    `if [ -f ${AGENT_CREDS} ]; then rm -rf ${MOUNT_CREDS} && cp -f ${AGENT_CREDS} ${MOUNT_CREDS} && chmod 600 ${MOUNT_CREDS}; fi`,
  ]);
}

export async function syncClaudeConfigOut(name: string): Promise<void> {
  if ((await getSandboxStatus(name)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    `if [ -f ${AGENT_CONFIG} ]; then rm -rf ${MOUNT_CONFIG} && cp -f ${AGENT_CONFIG} ${MOUNT_CONFIG} && chmod 600 ${MOUNT_CONFIG}; fi`,
  ]);
}

export async function startSandbox(name: string, worktreePath?: string, dashboardPort?: number): Promise<void> {
  if (runningPtys.has(name)) return;
  if (worktreePath && !(await sandboxExists(name))) {
    await createSandbox(name, worktreePath);
  }
  try {
    await syncCredentialsIn(name);
  } catch (err) {
    console.error(`syncCredentialsIn(${name}) failed:`, err);
  }
  try {
    await syncClaudeConfigIn(name, worktreePath);
  } catch (err) {
    console.error(`syncClaudeConfigIn(${name}) failed:`, err);
  }
  const dockerPath = resolveDockerPath();
  let term: IPty;
  try {
    term = pty.spawn(dockerPath, ["sandbox", "run", name], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env as { [key: string]: string },
    });
  } catch (err: any) {
    throw new Error(
      `pty.spawn ${dockerPath} sandbox run ${name} failed: ${err?.message || err}`
    );
  }
  const entry: SandboxPty = { term, buffer: "", subscribers: new Set() };
  term.onData((data) => {
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_LIMIT);
    for (const sub of entry.subscribers) sub(data);
  });
  term.onExit(() => {
    runningPtys.delete(name);
    syncCredentialsOut(name).catch((err) =>
      console.error(`syncCredentialsOut(${name}) on pty exit failed:`, err)
    );
    syncClaudeConfigOut(name).catch((err) =>
      console.error(`syncClaudeConfigOut(${name}) on pty exit failed:`, err)
    );
  });
  runningPtys.set(name, entry);

  if (worktreePath && dashboardPort) {
    ensureDashboardRunning(worktreePath, dashboardPort).catch((err) =>
      console.error(`ensureDashboardRunning(${worktreePath}:${dashboardPort}) failed:`, err)
    );
  }
}

export async function stopSandbox(name: string, worktreePath?: string): Promise<void> {
  try {
    await syncCredentialsOut(name);
  } catch (err) {
    console.error(`syncCredentialsOut(${name}) on stop failed:`, err);
  }
  try {
    await syncClaudeConfigOut(name);
  } catch (err) {
    console.error(`syncClaudeConfigOut(${name}) on stop failed:`, err);
  }
  const entry = runningPtys.get(name);
  if (entry) {
    try { entry.term.kill(); } catch {}
    runningPtys.delete(name);
  }
  if (worktreePath) stopDashboard(worktreePath);
  await run("docker", ["sandbox", "stop", name]);
}

export async function removeSandbox(name: string, worktreePath?: string): Promise<void> {
  const entry = runningPtys.get(name);
  if (entry) {
    try { entry.term.kill(); } catch {}
    runningPtys.delete(name);
  }
  if (worktreePath) stopDashboard(worktreePath);
  await run("docker", ["sandbox", "rm", name]);
}

export async function getSandboxStatus(name: string): Promise<"running" | "stopped" | "missing"> {
  const res = await run("docker", ["sandbox", "ls"]);
  for (const line of res.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === name) {
      return parts[2] === "running" ? "running" : "stopped";
    }
  }
  return "missing";
}

export async function sandboxLogs(name: string, tail = 200): Promise<string> {
  const res = await run("docker", ["sandbox", "exec", name, "sh", "-lc", `tail -n ${tail} /var/log/*.log 2>/dev/null || true`]);
  return (res.stdout + res.stderr).trim();
}
