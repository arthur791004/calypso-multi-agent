import { app, BrowserWindow, shell } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import net from "node:net";

const BACKEND_PORT = 9090;
const VITE_PORT = 9091;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const rootDir = path.resolve(__dirname, "..", "..");

let backend: ChildProcess | null = null;
let frontend: ChildProcess | null = null;

function spawnChild(name: string, cwd: string): ChildProcess {
  console.log(`[electron] spawning ${name} in ${cwd}`);
  const child = spawn("npm", ["run", "dev"], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
  });
  child.on("exit", (code, signal) => {
    console.log(`[${name}] exited code=${code} sig=${signal}`);
  });
  child.on("error", (err) => console.error(`[${name}] spawn error:`, err));
  return child;
}

function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(500);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const s = net.createConnection({ port, host });
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for ${host}:${port}`));
          return;
        }
        setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: "Calypso Multi-Agent",
    backgroundColor: "#0a0c10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(VITE_URL);
}

function killChildren(): void {
  if (backend) {
    try { backend.kill("SIGTERM"); } catch {}
    backend = null;
  }
  if (frontend) {
    try { frontend.kill("SIGTERM"); } catch {}
    frontend = null;
  }
}

app.whenReady().then(async () => {
  const backendAlready = await isPortOpen(BACKEND_PORT);
  const frontendAlready = await isPortOpen(VITE_PORT);

  if (backendAlready && frontendAlready) {
    console.log("[electron] attaching to existing dev servers on :9090/:9091");
  } else {
    if (!backendAlready) {
      backend = spawnChild("backend", path.join(rootDir, "backend"));
    }
    if (!frontendAlready) {
      frontend = spawnChild("frontend", path.join(rootDir, "frontend"));
    }
    try {
      await Promise.all([waitForPort(BACKEND_PORT), waitForPort(VITE_PORT)]);
    } catch (err) {
      console.error("[electron] services did not come up:", err);
    }
  }

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => console.error(err));
    }
  });
});

app.on("window-all-closed", () => {
  killChildren();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killChildren();
});
