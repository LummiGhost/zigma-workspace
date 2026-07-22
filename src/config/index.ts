import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ZigmaWorkspaceConfig } from "../types/index.js";

const STATE_DIR_NAME = ".zigma-workspace";

function getStateDir(): string {
  const envOverride = process.env["ZIGMA_WORKSPACE_STATE_DIR"];
  if (envOverride) {
    return envOverride;
  }
  return path.join(os.homedir(), STATE_DIR_NAME);
}

export function getConfig(stateDirOverride?: string): ZigmaWorkspaceConfig {
  const stateDir = stateDirOverride ?? getStateDir();
  return {
    stateDir,
    repoCacheDir: path.join(stateDir, "repo-cache"),
    workspacesDir: path.join(stateDir, "workspaces"),
    snapshotsDir: path.join(stateDir, "snapshots"),
    logsDir: path.join(stateDir, "logs"),
    dbPath: path.join(stateDir, "registry.db"),
  };
}

export function ensureStateDirs(config: ZigmaWorkspaceConfig): void {
  const dirs = [
    config.stateDir,
    config.repoCacheDir,
    config.workspacesDir,
    config.snapshotsDir,
    config.logsDir,
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function loadConfigFile(config: ZigmaWorkspaceConfig): Record<string, unknown> {
  const configPath = path.join(config.stateDir, "config.json");
  if (!fs.existsSync(configPath)) {
    const defaults: Record<string, unknown> = {
      version: "0.1.0",
      defaultMode: "writable",
      retainFailedDays: 7,
      maxDiskGb: 50,
    };
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf-8");
    return defaults;
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}
