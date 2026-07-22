# CLI 命令参考

本文档描述 `src/cli/index.ts` 当前实际提供的命令。以下示例假设已经构建并安装 `zigma-workspace`；开发环境可将命令替换为 `npm run dev --`。

## 全局用法

```text
zigma-workspace [options] [command]

Options:
  -V, --version            输出版本号
  --state-dir <path>       覆盖状态目录（绝对路径）
  -h, --help               显示帮助
```

所有子命令都支持 `--help`。命令失败时退出码为 `1`；Commander 参数解析错误也会以非零退出码结束。

### `--state-dir <path>`

将状态根目录覆盖为指定的绝对路径，优先级高于 `ZIGMA_WORKSPACE_STATE_DIR` 环境变量。用于隔离 CI 部署、测试环境，或在同一机器上并行运行多个实例。路径必须为绝对路径（Windows 和 POSIX 均支持）；传入相对路径时命令立即报错退出。

```powershell
# 将所有状态（SQLite、mirror、worktree、snapshot）写到临时目录
zigma-workspace --state-dir D:\temp\zigma-ci create --repo ... --base main --branch task/1 --json

# 等价的环境变量写法
$env:ZIGMA_WORKSPACE_STATE_DIR = "D:\temp\zigma-ci"
zigma-workspace create ...
```

## JSON 协议（`--json`）

所有业务命令都支持 `--json`。响应遵循版本化 envelope，成功和失败均包含 `contract_version` 字段。

**成功响应（stdout）：**

```json
{
  "contract_version": 1,
  "ok": true,
  "data": {}
}
```

**错误响应（stderr，进程退出码 1）：**

```json
{
  "contract_version": 1,
  "ok": false,
  "error": {
    "code": "WORKSPACE_NOT_FOUND",
    "message": "Workspace ws_... not found",
    "details": { "workspaceId": "ws_..." }
  }
}
```

### 稳定错误码

| 代码 | 含义 |
| --- | --- |
| `WORKSPACE_NOT_FOUND` | 指定 workspace ID 不存在于 registry |
| `WORKSPACE_LOCK_CONFLICT` | workspace 已被其他持有者加锁 |
| `WORKSPACE_DIRECTORY_NOT_FOUND` | workspace 路径在文件系统上不存在 |
| `GIT_ERROR` | Git 命令执行失败 |
| `INVALID_INPUT` | 参数值非法（如 `--mode` 值、`--state-dir` 非绝对路径） |
| `OPERATION_ID_CONFLICT` | `--operation-id` 已被不同输入占用 |
| `INTERNAL_ERROR` | 未预期的内部错误 |

## 幂等操作（`--operation-id`）

`create`、`bind-run`、`snapshot`、`cleanup` 支持 `--operation-id <id>` 参数，用于实现幂等重试。

- 首次调用：正常执行并持久化结果。
- 相同 `--operation-id` + 相同输入：直接返回首次结果（不重复执行）。
- 相同 `--operation-id` + 不同输入：返回 `OPERATION_ID_CONFLICT` 错误。

`operation-id` 由调用方自由指定，建议使用 UUID 或任务流水号。

```powershell
$opId = [guid]::NewGuid().ToString()

# 首次执行
zigma-workspace create --repo ... --base main --branch task/1 --operation-id $opId --json

# 重试（网络抖动或进程崩溃后）：返回与首次相同的响应
zigma-workspace create --repo ... --base main --branch task/1 --operation-id $opId --json
```

## 典型流程

```powershell
# 1. 创建 workspace，并从 JSON 中保存 ID
$result = zigma-workspace create `
  --repo https://github.com/example/project.git `
  --base main `
  --branch task/TASK-123 `
  --task TASK-123 `
  --json | ConvertFrom-Json
$workspaceId = $result.data.workspace_id

# 2. 获取写锁
zigma-workspace lock --workspace $workspaceId --mode write --owner agent-1

# 3. 在 status 返回的 path 中工作，然后收集差异和快照
zigma-workspace diff --workspace $workspaceId --json
zigma-workspace snapshot --workspace $workspaceId --json

# 4. 释放锁并清理 worktree
zigma-workspace unlock --workspace $workspaceId
zigma-workspace cleanup --workspace $workspaceId
```

## `create`

从 Git 仓库创建 workspace。

```text
zigma-workspace create --repo <url> --base <ref> --branch <branch> [options]
```

| 参数 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--repo <url>` | 是 | - | Git 仓库 URL；首次使用时创建 bare mirror，后续调用会 fetch。 |
| `--base <ref>` | 是 | - | 分支、tag 或 commit；解析为完整 commit SHA。 |
| `--branch <branch>` | 是 | - | 新 worktree 中创建的分支名；mirror 中已存在同名分支时 Git 会报错。 |
| `--mode <mode>` | 否 | `writable` | `writable` 或 `read-only`。 |
| `--project <projectId>` | 否 | - | 关联的项目 ID。 |
| `--task <taskId>` | 否 | - | 关联的任务 ID。 |
| `--flow-run <flowRunId>` | 否 | - | 关联的 flow run ID。 |
| `--operation-id <id>` | 否 | - | 幂等键，见[幂等操作](#幂等操作--operation-id)。 |
| `--json` | 否 | false | 输出机器可读 JSON。 |

创建成功后状态为 `prepared`，并在 workspace 根目录写入 `.zigma-workspace.json` manifest。

JSON `data` 字段：`workspace_id`、`path`、`branch`、`base_ref`、`base_commit`、`mode`、`status`、`manifest_path`、`created_at`。

## `bind-run`

将现有 workspace 关联到任务和/或 flow run，并把状态改为 `active`。

```text
zigma-workspace bind-run --workspace <id> [--task <taskId>] [--flow-run <flowRunId>] [--operation-id <id>] [--json]
```

未传入的绑定字段保留原值。磁盘上的 manifest 存在且可解析时会同步更新；manifest 更新失败不会导致命令失败。

## `status`

显示 workspace 记录以及当前锁，支持重启后对账。

```text
zigma-workspace status --workspace <id> [--json]
```

JSON `data` 包含完整的对账元数据：`workspace_id`、`status`、`branch`、`base_ref`、`base_commit`、`path`、`mode`、`repository_url`、`repository_cache_id`、`task_id`、`flow_run_id`、`project_id`、`created_at`、`updated_at`、`lock`（无锁时为 `null`）。

## `list`

按创建时间倒序列出全部 workspace，包括已经清理的记录。

```text
zigma-workspace list [--json]
```

没有记录时，人类可读输出为 `No workspaces found.`；JSON 输出的 `data` 是空数组。

## `lock`

为 workspace 获取一条协作锁记录，并把 workspace 状态改为 `locked`。

```text
zigma-workspace lock --workspace <id> --mode <read|write> --owner <owner> [options]
```

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `--workspace <id>` | 是 | Workspace ID。 |
| `--mode <mode>` | 是 | `read` 或 `write`。 |
| `--owner <owner>` | 是 | 锁持有者标识。 |
| `--expires-at <iso>` | 否 | 原样记录的 ISO 8601 到期时间。 |
| `--json` | 否 | 输出 JSON。 |

当前实现不允许一个 workspace 同时存在多条锁；`expires_at` 不会被自动检查或清理。

## `unlock`

删除 workspace 的锁。若 workspace 状态为 `locked`，状态会恢复为 `active`。

```text
zigma-workspace unlock --workspace <id> [--json]
```

重复解锁是成功的空操作。

## `diff`

收集相对创建时 base commit 的 Git 状态和 patch。

```text
zigma-workspace diff --workspace <id> [--patch-out <path>] [--json]
```

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `--workspace <id>` | 是 | Workspace ID。 |
| `--patch-out <path>` | 否 | patch 输出路径；父目录不存在时自动创建。 |
| `--json` | 否 | 输出 JSON。 |

未指定 `--patch-out` 且有 tracked diff 时，patch 自动写到状态目录的 `snapshots/`。

JSON `data` 包含：`base_commit`、`head_commit`、`changed_files`、`untracked_files`、`status_text`、`patch_path`、`patch_artifact`（见下）、`summary`。

### Artifact URI（`patch_artifact`）

当 patch 文件存在时，`patch_artifact` 提供可验证的引用：

```json
{
  "patch_artifact": {
    "uri": "file:///C:/Users/user/.zigma-workspace/snapshots/ws_xxx-1234.patch",
    "media_type": "text/x-diff",
    "digest": "sha256:a3f1..."
  }
}
```

`uri` 使用 `file://` 方案，路径为绝对路径并经过平台规范化（Windows 上驱动器字母和分隔符均正确处理）。`digest` 是 patch 内容的 SHA-256，格式为 `sha256:<hex>`。patch 为空时 `patch_artifact` 为 `null`。

## `snapshot`

记录 workspace 当前元数据，并在存在 tracked diff 时保存 patch。

```text
zigma-workspace snapshot --workspace <id> [--operation-id <id>] [--json]
```

每次调用都会在 `snapshots/<workspace-id>/` 写入 metadata JSON：

- 没有 patch 时，快照类型为 `metadata-only`，`artifact.media_type` 为 `application/json`。
- 有 patch 时，类型为 `diff`，`artifact.media_type` 为 `text/x-diff`，`artifact.digest` 为 SHA-256。

JSON `data` 包含：`snapshot_id`、`workspace_id`、`kind`、`path`、`checksum`、`artifact`（格式同 diff）、`created_at`。

## `cleanup`

删除 worktree 并将 registry 中的 workspace 状态改为 `cleaned`。

```text
zigma-workspace cleanup --workspace <id> [--operation-id <id>] [--json]
```

优先执行 `git worktree remove --force` 并 prune；失败时会尝试直接递归删除 workspace 目录。重复清理返回成功且 `removed: false`。

重要：当前实现无论文件系统删除最终是否成功，都会把数据库状态更新为 `cleaned`。自动化调用方必须检查返回的 `removed` 和 `message`，不能只检查进程退出码。

## 状态与持久化

CLI 使用 `--state-dir` 选项或 `ZIGMA_WORKSPACE_STATE_DIR` 环境变量指定状态根目录，均未设置时使用 `~/.zigma-workspace`。首次运行任何业务命令都会创建目录、`config.json` 和 SQLite schema（含幂等记录表 `workspace_idempotency`）。

当前可能出现的 workspace 状态包括：`created`、`prepared`、`locked`、`active`、`archived`、`cleaned`、`failed`。现有 CLI 实际写入 `prepared`、`active`、`locked` 和 `cleaned`；`created` 仅是创建过程中的短暂数据库状态。
