# Zigma Workspace PRD

文档版本：v0.1

状态：草案

日期：2026-07-13

仓库：`zigma-workspace`

## 1. 项目定位

Zigma Workspace 是 Zigma 平台的工作区、worktree、依赖缓存、执行目录、快照和清理管理组件。它负责为 Agent workflow 和 runner 提供安全、可复用、可审计、可清理的项目工作目录。

Zigma Workspace 的目标是把“在某个仓库里执行一次开发任务”抽象成可管理的 Workspace 生命周期。它管理 Git checkout、worktree、branch、base commit、workspace lock、diff collection、dependency cache、snapshot、cleanup policy 和未来 sandbox integration。

一句话定义：

Zigma Workspace 是 Zigma 的工作区控制面，负责把代码仓库转化为 runner 可以安全执行的隔离文件系统上下文。

## 2. 背景

`zigma-flow` 负责 workflow 状态推进，但不负责 Git worktree、执行目录隔离、依赖缓存和工作区清理。`zigma-runner` 为了在 Zigma 组件未完整安装时仍具备基本能力，会内置一部分 workspace 功能，例如通过 `git worktree` 创建工作区、收集 diff、清理目录。

随着 DataCat 开发任务变复杂，runner 内置能力会逐渐不足。多个任务并发执行、长期缓存、跨项目复用、workspace snapshot、可审计文件系统状态、沙箱隔离、依赖缓存管理，都需要独立组件承担。

Zigma Workspace 是 runner 内置 workspace 兼容层的长期服务化形态。

## 3. 目标

核心目标包括：

1. 为每个 Zigma Task 或 Flow Run 创建独立 workspace。
2. 支持 Git clone cache、bare mirror、worktree 和 branch 策略。
3. 维护 workspace 生命周期：create、prepare、lock、run-bound、snapshot、archive、cleanup。
4. 管理依赖缓存，降低 DataCat 等大型项目的重复安装和构建成本。
5. 收集 workspace diff、changed files、untracked files 和 dirty state。
6. 提供文件系统写入边界，防止任务越权修改 runtime state、secret 和其他 workspace。
7. 为 runner 提供稳定 API，让 runner 不必自己管理复杂工作区。
8. 为未来 Docker、devcontainer、Firecracker、远程执行节点预留 sandbox provider 接口。

## 4. 非目标范围

Zigma Workspace 不承担以下职责：

1. 不执行 Agent workflow。该职责属于 `zigma-flow` 和 `zigma-runner`。
2. 不管理 Zigma Task 和项目权限。该职责属于 `zigma-core`。
3. 不提供代码托管、Issue、PR、Review 平台。该职责属于 `zigma-code`。
4. 不调用 GitHub API。平台早期 GitHub 操作由 `zigma-runner` 的 `gh` 组件承担。
5. 不生成 Agent prompt，不解释 workflow DAG。
6. 不在 MVP 中实现强安全沙箱。MVP 先提供本地 worktree 隔离和路径策略。
7. 不在 MVP 中实现分布式文件系统。

## 5. 用户与使用者

第一类使用者是 `zigma-runner`。Runner 请求 Workspace 创建工作区，并在其中执行 `zigma-flow`。

第二类使用者是 `zigma-core`。Core 查询 workspace 状态、关联 task、触发清理策略。

第三类使用者是平台管理员。他们配置 workspace root、缓存策略、保留策略、最大并发和磁盘限制。

第四类使用者是未来 sandbox provider。Workspace 提供统一接口以支持容器和远程执行。

## 6. 核心概念

### 6.1 Workspace

Workspace 是一次任务或一组相关任务的文件系统上下文。

```ts
interface Workspace {
  id: string;
  projectId: string;
  repositoryId: string;
  mode: "read-only" | "writable";
  status: "creating" | "ready" | "locked" | "archived" | "cleaned" | "failed";
  path: string;
  baseRef: string;
  baseCommit: string;
  branch?: string;
  createdForTaskId?: string;
  createdForFlowRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 6.2 Workspace Manifest

Workspace Manifest 是写入 workspace 的机器可读元数据。

```json
{
  "workspace_id": "ws_...",
  "project_id": "datacat",
  "repository_id": "repo_...",
  "base_ref": "main",
  "base_commit": "...",
  "branch": "zigma/datacat/task-...",
  "mode": "writable",
  "path": "/zigma/workspaces/ws_...",
  "allowed_paths": ["."],
  "denied_paths": [".env", ".zigma-flow/runs/*/state.json"]
}
```

### 6.3 Repository Cache

Repository Cache 是本地 bare mirror 或 object cache，用于避免每个任务重复 clone。

```ts
interface RepositoryCache {
  id: string;
  repositoryId: string;
  remoteUrl: string;
  mirrorPath: string;
  lastFetchedAt?: string;
  status: "ready" | "fetching" | "failed";
}
```

### 6.4 Workspace Lock

Workspace Lock 防止多个 runner 同时写入同一 writable workspace。

```ts
interface WorkspaceLock {
  id: string;
  workspaceId: string;
  mode: "read" | "write";
  holderId: string;
  acquiredAt: string;
  expiresAt?: string;
}
```

### 6.5 Workspace Snapshot

Snapshot 是 workspace 在某个时间点的可审计状态记录。

```ts
interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  kind: "metadata" | "diff" | "archive";
  baseCommit: string;
  headCommit?: string;
  diffRef?: string;
  archiveRef?: string;
  createdAt: string;
}
```

### 6.6 Workspace Diff

Workspace Diff 是任务结束后的代码变化摘要。

```ts
interface WorkspaceDiff {
  workspaceId: string;
  baseCommit: string;
  headCommit?: string;
  changedFiles: ChangedFile[];
  untrackedFiles: string[];
  patchPath?: string;
  summary: string;
}
```

### 6.7 Cache Profile

Cache Profile 定义依赖缓存策略。

```ts
interface CacheProfile {
  id: string;
  projectId?: string;
  packageManagers: Array<"pnpm" | "npm" | "yarn" | "bun" | "cargo" | "pip" | "gradle">;
  cachePaths: string[];
  maxSizeBytes?: number;
  ttlSeconds?: number;
}
```

## 7. 功能需求

### FR-001 Workspace 创建

Workspace 必须支持基于 repository、base ref、mode 和 task metadata 创建工作区。

```ts
interface CreateWorkspaceInput {
  projectId: string;
  repositoryId: string;
  remoteUrl: string;
  baseRef: string;
  mode: "read-only" | "writable";
  branch?: string;
  taskId?: string;
  flowRunId?: string;
}
```

### FR-002 Repository Cache

必须支持本地 bare mirror 或等价 Git object cache。创建 workspace 时应优先复用 cache。

### FR-003 Worktree 管理

writable workspace 必须使用独立 worktree 或等价隔离机制。read-only workspace 可以使用共享 checkout，但不得允许写入。

### FR-004 Branch 策略

必须支持自动生成任务分支名，并记录 branch 与 task、flow run 的关联。

示例：

```text
zigma/datacat/task-123-import-wizard
zigma/datacat/run-20260713-0001
```

### FR-005 Workspace Lock

必须支持 read lock 和 write lock。write lock 同一时间只能有一个 holder。lock 必须支持过期或强制释放策略。

### FR-006 路径边界策略

Workspace 必须支持 allowed_paths 和 denied_paths。MVP 先提供检测和警告，后续可通过 sandbox provider 强制执行。

默认 denied paths 应包括：

```text
.env
.env.*
.zigma-flow/runs/*/state.json
.zigma-flow/runs/*/events.jsonl
.zigma-flow/config.json
```

### FR-007 Diff Collection

任务结束后必须能收集：

1. `git status`。
2. changed files。
3. untracked files。
4. staged / unstaged changes。
5. unified diff 或 patch file。
6. diff summary。

### FR-008 Snapshot

必须支持创建 metadata snapshot 和 diff snapshot。archive snapshot 可以在后续阶段实现。

### FR-009 Cleanup Policy

必须支持按策略清理 workspace：

```ts
interface CleanupPolicy {
  keepOnSuccess: boolean;
  keepOnFailure: boolean;
  ttlSeconds?: number;
  maxWorkspacesPerProject?: number;
  maxTotalSizeBytes?: number;
}
```

### FR-010 Dependency Cache

必须支持配置依赖缓存路径。MVP 可只提供路径挂载和清理，不实现智能依赖解析。

### FR-011 Sandbox Provider 预留

必须定义 sandbox provider 接口：

```ts
interface SandboxProvider {
  prepare(workspace: Workspace): Promise<SandboxHandle>;
  destroy(handle: SandboxHandle): Promise<void>;
}
```

MVP provider 为 local filesystem。后续可扩展 Docker、devcontainer、Firecracker 或远程 runner。

### FR-012 API

```ts
interface WorkspaceManagerApi {
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace>;
  lockWorkspace(input: LockWorkspaceInput): Promise<WorkspaceLock>;
  releaseLock(lockId: string): Promise<void>;
  collectDiff(workspaceId: string): Promise<WorkspaceDiff>;
  snapshotWorkspace(input: SnapshotWorkspaceInput): Promise<WorkspaceSnapshot>;
  cleanupWorkspace(input: CleanupWorkspaceInput): Promise<void>;
  getManifest(workspaceId: string): Promise<WorkspaceManifest>;
}
```

## 8. 数据模型

推荐表：

```text
workspaces
workspace_locks
workspace_snapshots
repository_caches
workspace_diffs
cache_profiles
cleanup_policies
workspace_events
```

文件系统布局建议：

```text
/zigma
  /repo-cache
    /<repository-id>.git
  /workspaces
    /<workspace-id>
      /.zigma-workspace.json
      /repo
  /snapshots
    /<workspace-id>
  /artifacts
    /<workspace-id>
```

## 9. 与其他组件的关系

### 9.1 与 zigma-runner

Runner 是 Workspace 的主要调用方。MVP 阶段 runner 内置 worktree 兼容层，平台化后替换为调用 Workspace API。

### 9.2 与 zigma-core

Core 使用 workspace references 关联 task、flow run 和 evidence。Core 可触发 cleanup policy，但不直接操作文件系统。

### 9.3 与 zigma-code

Code 提供长期代码托管对象。Workspace 从 Code 或外部 Git remote 准备 checkout，并在任务结束后向 Runner/Core 提供 diff，后续由 Code 记录 PR 或 delivery record。

### 9.4 与 zigma-flow

Flow 在 workspace 内运行，但不拥有 workspace 生命周期。Flow 产生的 `.zigma-flow/runs` 可以作为 workspace 内的运行产物，由 Runner 收集。

## 10. MVP 范围

MVP 聚焦本地 worktree 管理：

1. Repository cache。
2. create workspace。
3. writable worktree。
4. read-only checkout。
5. workspace manifest。
6. lock / release。
7. diff collection。
8. cleanup policy。
9. local filesystem sandbox provider。

MVP 可暂不实现：

1. Docker sandbox。
2. 远程执行节点。
3. 高级依赖缓存优化。
4. 完整 archive snapshot。
5. 分布式存储。
6. 强制文件系统访问控制。

## 11. Runner 兼容层关系

`zigma-runner` 自带部分 workspace 功能，是为了在 Zigma 组件未完整安装时仍然能运行完整开发流程。

兼容层应遵守 Workspace 的数据模型和命名习惯：

1. 使用同样的 workspace id 格式。
2. 生成同样的 manifest。
3. 使用同样的 branch naming policy。
4. 生成可迁移的 diff summary。
5. 将来能平滑切换到 `zigma-workspace` 服务。

## 12. DataCat 使用场景

1. Core 创建 DataCat Task。
2. Runner 或 Workspace 创建基于 DataCat main 分支的 writable workspace。
3. Workspace 复用 repo cache 和 pnpm cache。
4. Runner 在 workspace 中执行 `zigma-flow run-all`。
5. Flow 完成代码修改和测试。
6. Workspace 收集 diff 和 changed files。
7. Runner 将 diff 交给 GitHub `gh` 兼容组件或未来 Zigma Code。
8. Core 记录 workspace 和 evidence。
9. 成功合并后 Workspace 按策略清理。

## 13. 成功标准

1. 可以为一个 Git repository 创建独立 writable worktree。
2. 可以防止两个 writable runner 同时写入同一 workspace。
3. 可以收集完整 diff 和 untracked files。
4. 可以生成 workspace manifest。
5. 可以复用 repository cache。
6. 可以按策略清理 workspace。
7. Runner 可以用兼容层行为迁移到 Workspace API。

## 14. 风险与应对

### 风险一：工作区泄漏和磁盘膨胀

应对：cleanup policy、TTL、max size、workspace event log 和 pinned workspace 机制。

### 风险二：缓存污染

应对：cache profile 隔离项目，关键缓存只读挂载，失败任务可标记 cache suspicious。

### 风险三：路径越权

应对：MVP 先检测，后续通过 sandbox provider 强制执行。

### 风险四：Runner 兼容层和 Workspace 服务分叉

应对：共享 manifest、branch policy、diff summary 和 API contract。

## 15. 开发阶段建议

### P1 Local Workspace Core

实现 workspace model、manifest、root path、repository cache。

### P2 Worktree and Lock

实现 git worktree、branch naming、lock/release。

### P3 Diff and Snapshot

实现 status、changed files、patch、snapshot metadata。

### P4 Cleanup and Cache

实现 cleanup policy、cache profile、TTL。

### P5 Runner Migration Contract

让 `zigma-runner` 可以通过 Workspace API 替换内置兼容层。

### P6 Sandbox Provider

定义 provider 接口并实现 local provider，预留 Docker/devcontainer。
