# Zigma Workspace PRD

文档版本：v0.2

状态：草案

日期：2026-07-14

仓库：`zigma-workspace`

## 1. 项目定位

Zigma Workspace 是 Zigma 平台的工作区、worktree、依赖缓存、执行目录、快照和清理管理组件。它负责把“在某个代码仓库中执行一次 Agent 开发任务”转化为可创建、可锁定、可审计、可回收的文件系统上下文。

当前架构已移除 `zigma-runner`。因此 Zigma Workspace 不再定位为“给 runner 提供工作区”的服务，而是定位为 CLI/API-first 的工作区组件：`zigma-core` 可以直接调用它创建 workspace，`zigma-flow` 的 `script` / `check` step 也可以直接调用它的 CLI/API 来创建工作区、收集 diff、生成 snapshot 和执行 cleanup。

一句话定义：

Zigma Workspace 是 Zigma 的工作区控制面，为 `zigma-flow` workflow 和 `zigma-core` 任务生命周期提供可审计、可复用、可清理的代码执行目录。

## 2. 背景

`zigma-flow` 负责 workflow 状态推进，但不负责长期 Git cache、worktree 管理、依赖缓存、workspace lock、snapshot 和清理策略。MVP 阶段，`zigma-flow` 的 script step 可以直接调用 `git worktree`、`git diff` 等命令完成基础流程；但随着 DataCat 开发任务复杂化，直接在 workflow 中手写 Git 操作会逐渐变得重复、脆弱且难以审计。

Zigma Workspace 的目标是把这些确定性文件系统和 Git 操作封装为稳定 CLI/API，使它们既能被 `zigma-core` 在 flow 启动前调用，也能被 `zigma-flow` script/check step 在 workflow 内显式调用。

新的设计原则是：

1. Workspace 不执行 Agent workflow。
2. Workspace 不拥有任务流程。
3. Workspace 不依赖 Runner。
4. Workspace 提供 CLI-first 接口，方便 `zigma-flow` script/check step 直接使用。
5. Workspace 长期可演进为服务化 API 和 sandbox provider。

## 3. 目标

核心目标包括：

1. 为每个 Zigma Task 或 Flow Run 创建独立 workspace。
2. 支持 Git clone cache、bare mirror、worktree 和 branch 策略。
3. 维护 workspace 生命周期：create、prepare、lock、bind-run、snapshot、archive、cleanup。
4. 提供 CLI 命令，供 `zigma-flow` script/check step 直接调用。
5. 提供 API，供 `zigma-core` 在 flow 启动前创建或查询 workspace。
6. 管理依赖缓存，降低 DataCat 等大型项目的重复安装和构建成本。
7. 收集 workspace diff、changed files、untracked files、dirty state 和 patch artifact。
8. 提供文件系统写入边界，防止任务越权修改 runtime state、secret 和其他 workspace。
9. 为未来 Docker、devcontainer、Firecracker、远程执行节点预留 sandbox provider 接口。

## 4. 非目标范围

Zigma Workspace 不承担以下职责：

1. 不执行 Agent workflow。该职责属于 `zigma-flow`。
2. 不管理 Zigma Task、Project、权限快照和审批。该职责属于 `zigma-core`。
3. 不提供代码托管、Issue、PR、Review 平台。该职责属于 `zigma-code`。
4. 不调用 GitHub API，不创建 GitHub PR，不读取 GitHub Actions。MVP 阶段这些可由 `zigma-flow` script/check step 调用 `gh` 完成。
5. 不生成 Agent prompt，不解释 workflow DAG，不修改 `zigma-flow` state。
6. 不在 MVP 中实现强安全沙箱。MVP 先提供本地 worktree 隔离和路径策略。
7. 不在 MVP 中实现分布式文件系统。
8. 不实现或替代已删除的 `zigma-runner`。

## 5. 用户与使用者

第一类使用者是 `zigma-flow` workflow。Workflow 的 script/check step 可以调用 `zigma-workspace` CLI 来创建 workspace、绑定 run、收集 diff、生成 snapshot 或清理 workspace。

第二类使用者是 `zigma-core`。Core 可以在启动 flow 前调用 Workspace 创建执行目录，并把 WorkspaceRef 传入 flow inputs 或 context block。

第三类使用者是平台管理员。他们配置 workspace root、缓存策略、保留策略、最大并发和磁盘限制。

第四类使用者是未来 `zigma-code` 或其他平台组件。它们可以查询 workspace 的 branch、commit、diff 和 snapshot，生成 PR 或审计记录。

## 6. 核心概念

### 6.1 Workspace

Workspace 是一次任务使用的文件系统上下文。

```ts
interface Workspace {
  id: string;
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
  repositoryId?: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  path: string;
  mode: "read-only" | "writable";
  status: "created" | "prepared" | "locked" | "active" | "archived" | "cleaned" | "failed";
  createdAt: string;
  updatedAt: string;
}
```

### 6.2 Workspace Manifest

Workspace Manifest 是写入 workspace 内或 workspace registry 的机器可读描述。

```json
{
  "workspace_id": "ws_...",
  "project_id": "datacat",
  "task_id": "task_...",
  "flow_run_id": "flow_...",
  "repo": "https://github.com/LummiGhost/DataCat.git",
  "base_ref": "main",
  "base_commit": "...",
  "branch": "zigma/task-...",
  "path": "/zigma/workspaces/ws_...",
  "mode": "writable",
  "allowed_paths": ["."],
  "denied_paths": [".env", ".zigma-flow/runs/*/state.json"]
}
```

### 6.3 Repository Cache

Repository Cache 是复用 clone/fetch 成本的本地 bare mirror 或 object cache。

```ts
interface RepositoryCache {
  id: string;
  repositoryUrl: string;
  mirrorPath: string;
  lastFetchedAt?: string;
  defaultBranch?: string;
  status: "ready" | "fetching" | "failed";
}
```

### 6.4 Workspace Lock

Workspace Lock 防止多个流程同时写同一个工作区。

```ts
interface WorkspaceLock {
  id: string;
  workspaceId: string;
  mode: "read" | "write";
  owner: string;
  expiresAt?: string;
  acquiredAt: string;
}
```

### 6.5 Workspace Diff

Workspace Diff 是工作区变更证据。

```ts
interface WorkspaceDiff {
  workspaceId: string;
  baseCommit: string;
  headCommit?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  statusText: string;
  patchPath?: string;
  summary: string;
}
```

### 6.6 Workspace Snapshot

Snapshot 是工作区状态的可审计备份或引用。

```ts
interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  kind: "manifest" | "diff" | "archive" | "metadata-only";
  path?: string;
  checksum?: string;
  createdAt: string;
}
```

## 7. 功能需求

### FR-001 Workspace CLI

MVP 必须提供 CLI-first 接口。最低命令集：

```bash
zigma-workspace create --repo <url> --base <ref> --branch <branch> --mode writable
zigma-workspace bind-run --workspace <id> --task <taskId> --flow-run <flowRunId>
zigma-workspace status --workspace <id>
zigma-workspace diff --workspace <id> --patch-out <path>
zigma-workspace snapshot --workspace <id>
zigma-workspace cleanup --workspace <id>
```

这些命令应适合直接放入 `zigma-flow` script/check step。

### FR-002 Workspace 创建

Workspace 必须能基于 repository URL、base ref、branch name 创建本地工作目录。

创建流程：

1. 确保 repository cache 存在。
2. fetch base ref。
3. resolve base commit。
4. 创建 worktree。
5. 创建或 checkout task branch。
6. 写入 workspace manifest。
7. 输出 JSON 结果，供 `zigma-flow` 解析。

### FR-003 JSON 输出协议

所有 CLI 命令必须支持 `--json`，输出机器可读结果。示例：

```json
{
  "workspace_id": "ws_123",
  "path": "/zigma/workspaces/ws_123",
  "branch": "zigma/task-123",
  "base_commit": "abc123",
  "manifest_path": "/zigma/workspaces/ws_123/.zigma-workspace.json"
}
```

### FR-004 Workspace Registry

Workspace 必须维护本地 registry。MVP 可使用 SQLite 或 JSONL。

记录内容包括 workspace、cache、lock、snapshot、cleanup status。

### FR-005 Lock 管理

Workspace 必须支持 read/write lock。写锁用于 Agent 修改、测试、格式化、生成代码等步骤。读锁用于 diff、summary、审计等步骤。

### FR-006 Diff Collection

Workspace 必须能收集：

1. `git status --porcelain`。
2. changed files。
3. untracked files。
4. diff stat。
5. patch file。
6. base commit / current commit。
7. dirty state summary。

Diff 输出必须能作为 `zigma-flow` artifact 注册。

### FR-007 Path Policy

Workspace 必须支持基础路径策略：

1. denied paths，例如 `.env`、secret 文件、runtime state 文件。
2. allowed paths。
3. max file size。
4. symlink policy。
5. workspace root escape detection。

MVP 阶段可以只做静态检查和 cleanup 前检查。

### FR-008 Dependency Cache

Workspace 应支持配置依赖缓存：

1. pnpm store。
2. npm cache。
3. cargo cache。
4. pip cache。
5. Playwright browsers。
6. build cache。

MVP 可以先只提供 cache root 规划和 manifest 记录，不强制实现全部语言生态。

### FR-009 Snapshot and Archive

Workspace 必须支持生成 metadata snapshot 和 diff snapshot。后续可支持完整 archive。

### FR-010 Cleanup Policy

Workspace 必须支持 cleanup 策略：

1. 成功任务立即清理。
2. 失败任务保留 N 天。
3. 人工 pin 保留。
4. 超过磁盘阈值时清理最旧 workspace。
5. orphan worktree 检测。

### FR-011 API

除了 CLI，Workspace 应提供可嵌入 API 或服务 API 草案：

```ts
interface ZigmaWorkspaceApi {
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  bindRun(input: BindWorkspaceRunInput): Promise<Workspace>;
  getWorkspace(workspaceId: string): Promise<Workspace>;
  lockWorkspace(workspaceId: string, mode: "read" | "write"): Promise<WorkspaceLock>;
  collectDiff(workspaceId: string): Promise<WorkspaceDiff>;
  createSnapshot(workspaceId: string): Promise<WorkspaceSnapshot>;
  cleanupWorkspace(workspaceId: string): Promise<void>;
}
```

## 8. 数据模型

MVP 推荐 SQLite。核心表：

```text
workspaces
repository_caches
workspace_locks
workspace_snapshots
workspace_events
cleanup_jobs
path_policy_profiles
cache_profiles
```

本地目录建议：

```text
~/.zigma-workspace
  /config.json
  /registry.db
  /repo-cache
  /workspaces
  /snapshots
  /logs
```

## 9. 与其他组件关系

### 9.1 与 zigma-flow

`zigma-flow` 可以通过 script/check step 调用 `zigma-workspace` CLI。Workspace 命令输出的 JSON、diff、patch、snapshot 应被 flow 注册为 artifact。

示例：

```yaml
steps:
  - id: prepare-workspace
    type: script
    run: zigma-workspace create --repo "$REPO" --base main --branch "$BRANCH" --json > workspace.json
```

### 9.2 与 zigma-core

Core 可以直接调用 Workspace 创建 workspace，并将 WorkspaceRef 传入 flow inputs。Core 负责将 workspace 关联到 Task 和 Evidence Bundle，但不管理底层 worktree 细节。

### 9.3 与 zigma-code

平台化阶段，Zigma Code 可读取 workspace diff、branch、commit、snapshot，用于创建 PR、保存 review evidence 或执行 merge policy。

### 9.4 与 zigma-runner

`zigma-runner` 已从当前架构中移除。Workspace 不依赖 Runner，也不为 Runner 设计专用接口。

## 10. MVP 范围

MVP 必须做到：

1. CLI-first。
2. Repository cache。
3. `git worktree` workspace 创建。
4. Workspace manifest。
5. Workspace registry。
6. Basic lock。
7. Diff collection。
8. Patch artifact 输出。
9. Cleanup。
10. JSON output。

MVP 可暂不实现：

1. Docker sandbox。
2. Firecracker。
3. 远程执行节点。
4. 完整 archive snapshot。
5. 全语言依赖缓存。
6. Web UI。
7. `zigma-code` 深度集成。

## 11. DataCat 使用场景

### 11.1 Flow script 创建 workspace

1. `zigma-flow` 启动 DataCat workflow。
2. 第一个 script step 调用 `zigma-workspace create` 创建 DataCat worktree。
3. Flow 将 workspace JSON 注册为 artifact 或 context block。
4. 后续 agent/script/check step 在 workspace path 中执行代码修改、测试、diff。
5. Flow 调用 `zigma-workspace diff` 收集 patch。
6. Flow 调用 `gh pr create` 或未来 `zigma-code pr create` 交付 PR。
7. Core 收集 evidence。

### 11.2 Core 预创建 workspace

1. Core 创建 DataCat Task。
2. Core 调用 Workspace API 创建 workspace。
3. Core 启动 `zigma-flow` 并传入 workspace path。
4. Flow 在该 workspace 中执行开发流程。
5. Flow 或 Core 调用 Workspace 收集 diff 和 snapshot。

## 12. 成功标准

1. `zigma-workspace create` 可以为 DataCat 创建独立 worktree。
2. CLI 输出可被 `zigma-flow` script step 可靠解析。
3. `zigma-workspace diff` 可以生成 changed files、status、patch 和 summary。
4. Workspace manifest 能被 Core 和 Flow 共同引用。
5. Cleanup 可以清理成功任务并保留失败任务。
6. 不依赖 `zigma-runner`。

## 13. 风险与应对

### 风险一：flow 中直接调用 CLI 难以标准化

应对：所有命令支持 `--json`，并保持稳定输出 schema。

### 风险二：workspace path 泄漏或越界写入

应对：manifest、path policy、denied paths、cleanup 前检查。

### 风险三：worktree 清理失败

应对：记录 registry，提供 orphan worktree 检测和强制 cleanup。

### 风险四：未来需要服务化

应对：CLI 与 API 使用同一核心库，未来服务端只是 API 包装。

## 14. 开发阶段建议

### P1 Workspace CLI Skeleton

建立 CLI、配置、registry、日志和 JSON 输出协议。

### P2 Git Cache and Worktree

实现 clone/fetch/cache/worktree/branch/manifest。

### P3 Diff and Snapshot

实现 diff、patch、status、snapshot。

### P4 Lock and Path Policy

实现基础 lock、denied paths 和 workspace root escape 检查。

### P5 Cleanup

实现 cleanup policy 和 orphan worktree 检测。

### P6 DataCat Dogfood

在 `zigma-flow` workflow 中调用 `zigma-workspace` 完成真实 DataCat workspace 生命周期。