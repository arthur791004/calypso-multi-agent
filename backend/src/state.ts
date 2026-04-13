import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type BranchStatus = "creating" | "stopped" | "starting" | "running" | "error";

export interface Branch {
  id: string;
  name: string;
  worktreePath: string;
  sandboxName?: string;
  port: number;
  status: BranchStatus;
  createdAt: number;
  error?: string;
  prUrl?: string;
}

export interface Settings {
  repoUrl: string;
  repoPath: string;
  worktreesDir: string;
  defaultBranch?: string;
  dashboardInstallCmd?: string;
  dashboardStartCmd?: string;
  configured: boolean;
}

export const DEFAULT_DASHBOARD_INSTALL_CMD = "yarn install";
export const DEFAULT_DASHBOARD_START_CMD = "yarn start-dashboard";

interface StateFile {
  branches: Record<string, Branch>;
  activeBranchId?: string;
  settings?: Settings;
}

const statePath = path.join(config.dataDir, "state.json");

export const TRUNK_ID = "trunk";
const TRUNK_PORT = 4000;

let state: StateFile = { branches: {} };

function ensureTrunk() {
  if (!state.branches) state.branches = {};
  if (!state.branches[TRUNK_ID]) {
    state.branches[TRUNK_ID] = {
      id: TRUNK_ID,
      name: "trunk",
      worktreePath: config.repoPath,
      port: TRUNK_PORT,
      status: "stopped",
      createdAt: 0,
    };
  }
}

export async function loadState(): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.tasks && !parsed.branches) {
      parsed.branches = {};
      for (const [id, t] of Object.entries<any>(parsed.tasks)) {
        parsed.branches[id] = {
          id: t.id,
          name: t.branch ?? t.name,
          worktreePath: t.worktreePath,
          sandboxName: t.sandboxName,
          port: t.port,
          status: t.status,
          createdAt: t.createdAt,
          error: t.error,
        };
      }
      delete parsed.tasks;
      if (parsed.activeTaskId && !parsed.activeBranchId) {
        parsed.activeBranchId = parsed.activeTaskId;
        delete parsed.activeTaskId;
      }
    }
    state = parsed;
    if (!state.branches) state.branches = {};
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  ensureTrunk();
}

async function persist(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

export function listBranches(): Branch[] {
  return Object.values(state.branches).sort((a, b) => a.createdAt - b.createdAt);
}

export function getBranch(id: string): Branch | undefined {
  return state.branches[id];
}

export async function upsertBranch(branch: Branch): Promise<Branch> {
  state.branches[branch.id] = branch;
  await persist();
  return branch;
}

export async function updateBranch(id: string, patch: Partial<Branch>): Promise<Branch> {
  const existing = state.branches[id];
  if (!existing) throw new Error(`Branch ${id} not found`);
  const next = { ...existing, ...patch };
  state.branches[id] = next;
  await persist();
  return next;
}

export async function removeBranch(id: string): Promise<void> {
  delete state.branches[id];
  if (state.activeBranchId === id) state.activeBranchId = undefined;
  await persist();
}

export function getActiveBranchId(): string | undefined {
  return state.activeBranchId;
}

export async function setActiveBranchId(id: string | undefined): Promise<void> {
  state.activeBranchId = id;
  await persist();
}

export function getSettings(): Settings {
  if (!state.settings) {
    state.settings = {
      repoUrl: config.defaultRepoUrl,
      repoPath: config.repoPath,
      worktreesDir: config.worktreesDir,
      configured: false,
    };
  }
  return state.settings;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...getSettings(), ...patch };
  state.settings = next;
  await persist();
  return next;
}

export function usedPorts(): Set<number> {
  return new Set(Object.values(state.branches).map((b) => b.port));
}

export function allocatePort(): number {
  const used = usedPorts();
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("No free ports in configured range");
}
