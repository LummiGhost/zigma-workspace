import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";

const STATE_DIR_NAME = ".zigma-workspace";

function getStateDir(): string {
  const envOverride = process.env["ZIGMA_WORKSPACE_STATE_DIR"];
  if (envOverride) {
    return envOverride;
  }
  return path.join(os.homedir(), STATE_DIR_NAME);
}

export function getConfig(stateDirOverride?: string): ZigmaWorkspaceConfig {
  if (stateDirOverride !== undefined && !path.isAbsolute(stateDirOverride)) {
    throw new ZigmaError("INVALID_INPUT", `--state-dir must be an absolute path, got: "${stateDirOverride}"`);
  }
  const stateDir = stateDirOverride ?? getStateDir();
  const configPath = path.join(stateDir, "config.json");
  let maxDiskGb = 50;
  let retainFailedDays = 7;
  if (fs.existsSync(configPath)) {
    const stored = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (typeof stored["maxDiskGb"] === "number" && Number.isFinite(stored["maxDiskGb"]) && stored["maxDiskGb"] >= 0) {
      maxDiskGb = stored["maxDiskGb"];
    }
    if (typeof stored["retainFailedDays"] === "number" && Number.isInteger(stored["retainFailedDays"]) && stored["retainFailedDays"] >= 0) {
      retainFailedDays = stored["retainFailedDays"];
    }
  }
  return {
    stateDir,
    repoCacheDir: path.join(stateDir, "repo-cache"),
    workspacesDir: path.join(stateDir, "workspaces"),
    snapshotsDir: path.join(stateDir, "snapshots"),
    logsDir: path.join(stateDir, "logs"),
    dbPath: path.join(stateDir, "registry.db"),
    maxDiskBytes: Math.floor(maxDiskGb * 1024 * 1024 * 1024),
    retainFailedDays,
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
