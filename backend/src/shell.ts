import { spawn, SpawnOptions } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

export async function runOrThrow(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<string> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.code}): ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}
