export interface Branch {
  id: string;
  name: string;
  worktreePath: string;
  sandboxName?: string;
  port: number;
  status: "creating" | "stopped" | "starting" | "running" | "error";
  createdAt: number;
  error?: string;
  prUrl?: string;
  hasChanges?: boolean;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Settings {
  repoUrl: string;
  repoPath: string;
  worktreesDir: string;
  configured: boolean;
  dashboardInstallCmd?: string;
  dashboardStartCmd?: string;
  repoExists?: boolean;
  repoLinkTarget?: string;
}

export interface SaveSettingsBody extends Partial<Settings> {
  linkTarget?: string;
}

export const api = {
  getSettings: () => fetch("/api/settings").then(j<Settings>),
  saveSettings: (body: SaveSettingsBody) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<Settings>),
  pickFolder: async (): Promise<{ path: string } | null> => {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  },
  list: () => fetch("/api/branches").then(j<{ branches: Branch[]; activeBranchId?: string }>),
  create: (body: { name: string; base?: string }) =>
    fetch("/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<Branch>),
  gitBranches: () =>
    fetch("/api/git-branches").then(j<{ branches: string[] }>),
  toggle: (id: string) => fetch(`/api/branches/${id}/toggle`, { method: "POST" }).then(j<Branch>),
  startDashboard: (id: string) =>
    fetch(`/api/branches/${id}/start-dashboard`, { method: "POST" }).then(j<{ running: true }>),
  createPR: (id: string) =>
    fetch(`/api/branches/${id}/create-pr`, { method: "POST" }).then(j<{ url: string }>),
  openEditor: (id: string) =>
    fetch(`/api/branches/${id}/open-editor`, { method: "POST" }).then(j<{ ok: true }>),
  switch: (id: string) =>
    fetch(`/api/branches/${id}/switch`, { method: "POST" }).then(j<{ activeBranchId: string }>),
  logs: (id: string) => fetch(`/api/branches/${id}/logs`).then(j<{ logs: string }>),
  remove: (id: string) => fetch(`/api/branches/${id}`, { method: "DELETE" }).then(j<{ ok: true }>),
};
