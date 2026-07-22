# TypeScript API 参考

`package.json` 的 `exports` 字段将包的公共入口指向 `dist/api/index.js`（对应源码 `src/api/index.ts`），外部消费者应从这里导入，而不是直接引用内部模块路径。

```ts
import {
  CONTRACT_VERSION,
  ZigmaError,
  getConfig,
  ensureStateDirs,
  openDb,
  createWorkspace,
} from "zigma-workspace";

const config = getConfig();          // 使用 ZIGMA_WORKSPACE_STATE_DIR 或 ~/.zigma-workspace
ensureStateDirs(config);
const db = openDb(config);

try {
  const workspace = createWorkspace(db, config, {
    repositoryUrl: "https://github.com/example/project.git",
    baseRef: "main",
    branch: "task/example",
    mode: "writable",
  });
  console.log(workspace.id, workspace.path);
} catch (err) {
  if (err instanceof ZigmaError) {
    console.error(err.code, err.message, err.details);
  }
}
```

## 库公共 API（`src/api/index.ts`）

以下类型和函数通过 `src/api/index.ts` 统一导出：

### 合约常量和类型

```ts
const CONTRACT_VERSION: 1;

type ZigmaErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_LOCK_CONFLICT"
  | "WORKSPACE_DIRECTORY_NOT_FOUND"
  | "GIT_ERROR"
  | "INVALID_INPUT"
  | "OPERATION_ID_CONFLICT"
  | "INTERNAL_ERROR";

class ZigmaError extends Error {
  readonly code: ZigmaErrorCode;
  readonly details?: Record<string, unknown>;
}

interface JsonOkResponse<T = unknown> {
  contract_version: 1;
  ok: true;
  data: T;
}

interface JsonErrorResponse {
  contract_version: 1;
  ok: false;
  error: { code: ZigmaErrorCode; message: string; details?: Record<string, unknown> };
}

type JsonResponse<T = unknown> = JsonOkResponse<T> | JsonErrorResponse;
```

### 路径语义

- 所有路径均为绝对路径，由 `path.join()` 生成；在 Windows 上使用本地分隔符，在 POSIX 上使用 `/`。
- `getConfig(stateDirOverride?)` 接受可选的绝对路径覆盖；传入相对路径时抛出 `INVALID_INPUT`。
- artifact URI（`patch_artifact.uri`、`artifact.uri`）由 Node.js 内置 `pathToFileURL()` 生成，格式为 `file:///`，Windows 驱动器字母和反斜杠均正确处理。
- UTF-8 路径由底层 `fs` 和 Git 透传；UNC 路径（`\\server\share`）未经测试。

## 配置 API

模块：`src/config/index.ts`

### `getConfig(stateDirOverride?: string): ZigmaWorkspaceConfig`

根据 `stateDirOverride`、`ZIGMA_WORKSPACE_STATE_DIR`（若设置）或 `~/.zigma-workspace` 生成路径配置（优先级从高到低）。传入非绝对路径时抛出 `ZigmaError("INVALID_INPUT", ...)`。

```ts
interface ZigmaWorkspaceConfig {
  stateDir: string;
  repoCacheDir: string;
  workspacesDir: string;
  snapshotsDir: string;
  logsDir: string;
  dbPath: string;
}
```

此函数只计算路径，不创建目录。

### `ensureStateDirs(config): void`

递归创建 state、repo cache、workspace、snapshot 和 log 目录。

### `loadConfigFile(config): Record<string, unknown>`

读取 `<stateDir>/config.json`。文件不存在时创建以下默认内容并返回：

```json
{
  "version": "0.1.0",
  "defaultMode": "writable",
  "retainFailedDays": 7,
  "maxDiskGb": 50
}
```

无效 JSON 会直接抛出解析错误。当前核心 API 不消费这些配置项。

## 数据库 API

模块：`src/db/index.ts`

### `openDb(config): Database.Database`

打开 `config.dbPath`，启用 WAL 和 foreign keys，并按需创建表。进程内以 `dbPath` 为键缓存连接：同一路径的多次调用返回相同连接；不同路径（如使用 `--state-dir`）各自维护独立连接。

### `closeDb(config?: ZigmaWorkspaceConfig): void`

传入 `config` 时关闭并移除对应路径的缓存连接；不传时关闭并清除所有缓存连接。

`src/db/queries.ts` 还导出 workspace、repository cache、lock、snapshot 和 event 的低层 CRUD 函数。这些函数直接接收/返回数据库 row 类型，不做业务校验，通常应优先使用 core API。

## Workspace API

模块：`src/core/workspace.ts`

### `createWorkspace(db, config, input): Workspace`

```ts
interface CreateWorkspaceInput {
  repositoryUrl: string;
  baseRef: string;
  branch: string;
  mode?: "read-only" | "writable";
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
}
```

执行顺序：

1. 检查 Git 是否可用。
2. 为 URL 创建或更新 bare mirror。
3. 将 `baseRef` 解析为 commit。
4. 用 `git worktree add -b` 创建新分支和 worktree。
5. 插入数据库记录、写入 `.zigma-workspace.json`，并把状态改为 `prepared`。
6. 写入 `workspace.created` 事件并返回 `Workspace`。

网络、Git、文件系统或数据库错误会抛出。该操作不是跨这些资源的事务；中途失败可能留下 cache、worktree 或部分记录。

### `bindRun(db, input): Workspace`

```ts
interface BindWorkspaceRunInput {
  workspaceId: string;
  taskId?: string;
  flowRunId?: string;
}
```

更新传入的绑定，保留未传字段，将状态改为 `active`，记录 `workspace.bound` 事件，并尽力同步 manifest。workspace 不存在时抛出。

### `getWorkspace(db, workspaceId): Workspace`

按 ID 返回 workspace；不存在时抛出 `Workspace <id> not found`。

### `listAllWorkspaces(db): Workspace[]`

按 `created_at DESC` 返回全部记录。

## Lock API

模块：`src/core/lock.ts`

### `lockWorkspace(db, workspaceId, mode, owner, expiresAt?): WorkspaceLock`

为 workspace 插入一条锁，状态改为 `locked`，并记录 `workspace.locked` 事件。`mode` 类型为 `"read" | "write"`。

同一 workspace 已有任何锁时抛出；函数不检查锁是否过期，也不验证 `expiresAt` 格式。

### `unlockWorkspace(db, workspaceId): void`

删除锁。如果原 workspace 状态为 `locked`，将其改为 `active` 并记录事件。没有锁时是空操作；此时不会写事件，也不会改变状态。

### `getLock(db, workspaceId): WorkspaceLock | null`

返回按 `acquired_at` 倒序查询到的最新锁，或 `null`。它不会验证 workspace 是否存在或锁是否过期。

## Diff API

模块：`src/core/diff.ts`

### `collectDiff(db, config, workspaceId, patchOutPath?): WorkspaceDiff`

返回：

```ts
interface WorkspaceDiff {
  workspaceId: string;
  baseCommit: string;
  headCommit?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  statusText: string;
  patchPath?: string;
  patchDigest?: string;  // SHA-256 hex of patch content; present when patchPath is set
  summary: string;
}
```

workspace 记录或目录不存在时抛出。patch 非空时写入显式路径，或自动写入 `config.snapshotsDir`。函数记录 `workspace.diff.collected` 事件，其中包含文件计数、patch 路径和 SHA-256。

Git 查询辅助函数多数采用“失败时返回空值”的策略，因此个别 Git 失败可能表现为空 diff，而不是异常。patch 不包含未跟踪文件。

## Snapshot API

模块：`src/core/snapshot.ts`

### `createSnapshot(db, config, workspaceId): WorkspaceSnapshot`

始终写 metadata JSON 并插入数据库记录；若相对 base commit 存在 tracked diff，还写 patch 并返回 `kind: "diff"` 和 SHA-256，否则返回 `kind: "metadata-only"`。同时记录 `workspace.snapshot.created` 事件。

### `listSnapshots(db, workspaceId): WorkspaceSnapshot[]`

按创建时间倒序返回数据库中的快照。此函数不验证 workspace 是否存在，也不检查快照文件是否仍在磁盘。

## Cleanup API

模块：`src/core/cleanup.ts`

### `cleanupWorkspace(db, config, workspaceId): CleanupResult`

```ts
interface CleanupResult {
  workspaceId: string;
  path: string;
  removed: boolean;
  message: string;
}
```

优先通过 mirror 删除并 prune worktree，失败时直接删除目录。随后写入 `workspace.cleaned` 事件并把状态改为 `cleaned`。

重要：即使目录删除失败，状态仍会改为 `cleaned`，函数也会正常返回 `removed: false`。调用方应显式检查结果。

### `detectOrphanWorktrees(db, config): OrphanWorktreeInfo[]`

扫描数据库中涉及的 mirror，返回 Git 已登记、但不属于任何未清理 workspace 记录的 worktree。`config` 参数当前未使用。无法读取某个 mirror 的 worktree 列表时，该 mirror 被视为空列表。

## Git API

模块：`src/git/index.ts`

该模块提供底层同步 Git 封装：

| 函数 | 行为 |
| --- | --- |
| `hashRepoUrl(url)` | 返回 URL SHA-256 的前 16 个十六进制字符。 |
| `cloneMirror(repoUrl, mirrorPath)` | 执行 bare mirror clone；目录已存在时跳过。 |
| `fetchMirror(mirrorPath)` | `git fetch --all --prune`。 |
| `resolveRef(mirrorPath, ref)` | 依次尝试 ref、`refs/heads/<ref>`、`origin/<ref>`。 |
| `createWorktree(...)` | 从 base commit 创建新分支和 worktree。 |
| `removeWorktree(...)` | 强制移除，失败时直接删目录，再尽力 prune。 |
| `listWorktrees(mirrorPath)` | 解析 porcelain 输出；失败返回空数组。 |
| `getStatus(path)` | porcelain status；失败返回空字符串。 |
| `getChangedFiles(path, base)` | base 到 HEAD 的 tracked 文件列表。 |
| `getUntrackedFiles(path)` | 未跟踪且未被 ignore 的文件列表。 |
| `getDiffStat(path, base)` | 相对 base 的 diff stat。 |
| `generatePatch(path, base)` | 相对 base 的 tracked diff；失败返回空字符串。 |
| `getHeadCommit(path)` | 当前 HEAD SHA；失败返回 `undefined`。 |
| `checkGitAvailable()` | Git 不可用时抛出。 |
| `getDefaultBranch(mirrorPath)` | 从 bare repo 的 HEAD symbolic ref 获取默认分支。 |
| `configureWorktreeMode(path, mode)` | read-only 时写 `core.readOnly=true` 标记，不强制文件只读。 |
| `commitAllChanges(path, message)` | stage 并提交全部变化；无变化或失败返回 `undefined`。 |
| `safeGitOutput(args, cwd)` | 执行 Git；失败返回空字符串。 |

`runGit(args, cwd?, env?)` 也被公开导出。失败时抛出 `GitError`，其中包含 `command` 和 `stderr`。所有 Git 调用为同步调用，禁用终端凭据提示，stdout buffer 上限为 50 MiB；服务端调用时应考虑阻塞事件循环的影响。

## 数据类型

所有公共类型定义在 `src/types/index.ts`。核心 `Workspace` 状态联合类型为：

```ts
type WorkspaceStatus =
  | "created"
  | "prepared"
  | "locked"
  | "active"
  | "archived"
  | "cleaned"
  | "failed";
```

ID 由 UUID v4 加前缀构成：`ws_`、`cache_`、`lock_`、`snap_`、`evt_`。时间字段使用 `new Date().toISOString()` 生成的 UTC ISO 8601 字符串。

