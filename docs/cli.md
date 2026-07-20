# CLI 命令参考

本文档描述 `src/cli/index.ts` 当前实际提供的命令。以下示例假设已经构建并安装 `zigma-workspace`；开发环境可将命令替换为 `npm run dev --`。

## 全局用法

```text
zigma-workspace [options] [command]

Options:
  -V, --version   输出版本号
  -h, --help      显示帮助
```

所有子命令都支持 `--help`。命令失败时退出码为 `1`；Commander 参数解析错误也会以非零退出码结束。

大部分命令支持 `--json`。成功输出统一为：

```json
{
  "ok": true,
  "data": {}
}
```

业务错误写入 stderr：

```json
{
  "ok": false,
  "error": "错误消息"
}
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
| `--json` | 否 | false | 输出机器可读 JSON。 |

创建成功后状态为 `prepared`，并在 workspace 根目录写入 `.zigma-workspace.json` manifest。manifest 默认声明 `allowed_paths: ["."]`，以及 `denied_paths: [".env", ".zigma-workspace.json"]`；当前 CLI 只记录这些规则，不负责强制执行。

JSON `data` 字段：`workspace_id`、`path`、`branch`、`base_ref`、`base_commit`、`mode`、`status`、`manifest_path`、`created_at`。

## `bind-run`

将现有 workspace 关联到任务和/或 flow run，并把状态改为 `active`。

```text
zigma-workspace bind-run --workspace <id> [--task <taskId>] [--flow-run <flowRunId>] [--json]
```

未传入的绑定字段保留原值。磁盘上的 manifest 存在且可解析时会同步更新；manifest 更新失败不会导致命令失败。

## `status`

显示 workspace 记录以及当前锁。

```text
zigma-workspace status --workspace <id> [--json]
```

JSON 输出包含 workspace 的所有主要字段，以及 `lock`。无锁时 `lock` 为 `null`。

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

当前实现不允许一个 workspace 同时存在多条锁，不区分共享读锁与独占写锁；`expires_at` 不会被自动检查或清理。

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

未指定 `--patch-out` 且 patch 非空时，文件自动写到状态目录的 `snapshots/`。没有 tracked diff 时不会创建 patch 文件。

JSON `data` 包含 `base_commit`、`head_commit`、`changed_files`、`untracked_files`、`status_text`、`patch_path` 和 `summary`。

注意：

- `changed_files` 来自 `git diff --name-only <base> HEAD`，表示 base 到当前 HEAD 的已提交文件变化，不完整代表工作区未提交变化。
- `status_text` 包含工作区 porcelain 状态。
- patch 来自 `git diff <base>`，包含 tracked 文件的已提交和未提交变化，但不包含未跟踪文件。
- `untracked_files` 单独列出未跟踪文件名，文件内容不会进入 patch。

## `snapshot`

记录 workspace 当前元数据，并在存在 tracked diff 时保存 patch。

```text
zigma-workspace snapshot --workspace <id> [--json]
```

每次调用都会在 `snapshots/<workspace-id>/` 写入 metadata JSON：

- 没有 patch 时，快照类型为 `metadata-only`，返回路径指向 metadata 文件。
- 有 patch 时，类型为 `diff`，返回路径指向 patch 文件，并返回 patch 的 SHA-256 checksum；metadata 文件仍会保留。

快照不会提交 Git 变化，也不会打包完整目录；未跟踪文件不包含在 patch 中。

## `cleanup`

删除 worktree 并将 registry 中的 workspace 状态改为 `cleaned`。

```text
zigma-workspace cleanup --workspace <id> [--json]
```

优先执行 `git worktree remove --force` 并 prune；失败时会尝试直接递归删除 workspace 目录。重复清理返回成功且 `removed: false`。

重要：当前实现无论文件系统删除最终是否成功，都会把数据库状态更新为 `cleaned`。自动化调用方必须检查返回的 `removed` 和 `message`，不能只检查进程退出码。

## 状态与持久化

CLI 使用 `ZIGMA_WORKSPACE_STATE_DIR` 指定状态根目录，未设置时使用 `~/.zigma-workspace`。首次运行任何业务命令都会创建目录、`config.json` 和 SQLite schema。

当前可能出现的 workspace 状态包括：`created`、`prepared`、`locked`、`active`、`archived`、`cleaned`、`failed`。现有 CLI 实际写入 `prepared`、`active`、`locked` 和 `cleaned`；`created` 仅是创建过程中的短暂数据库状态。

