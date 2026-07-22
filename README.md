# zigma-workspace

`zigma-workspace` 是一个本地 workspace 管理 CLI。它为 Git 仓库维护可复用的 bare mirror，基于指定 ref 创建独立 worktree，并用 SQLite 记录 workspace、锁、快照和事件。

## 快速开始

要求：Node.js 18+、Git。

```powershell
npm install
npm run build
node dist/cli/index.js --help
```

开发时可用：

```powershell
npm run dev -- --help
```

安装为全局命令后，或通过 npm 包的 `bin` 入口调用时，命令名为 `zigma-workspace`。

```powershell
zigma-workspace create `
  --repo https://github.com/example/project.git `
  --base main `
  --branch task/example `
  --task TASK-123 `
  --json
```

默认状态目录是用户主目录下的 `.zigma-workspace`。如需隔离测试或 CI 状态，可通过全局选项或环境变量指定绝对路径：

```powershell
# 全局选项（优先级更高）
zigma-workspace --state-dir D:\temp\zigma-state create ...

# 环境变量
$env:ZIGMA_WORKSPACE_STATE_DIR = "D:\temp\zigma-state"
```

状态目录包含：

```text
.zigma-workspace/
├── config.json
├── registry.db
├── repo-cache/
├── workspaces/
├── snapshots/
└── logs/
```

## 文档

- [CLI 命令参考](docs/cli.md)
- [TypeScript API 参考](docs/api.md)
- [产品需求文档](docs/prd.md)

## 当前实现范围

- `read-only` 模式目前只写入本地 Git 配置标记，不会阻止文件写入。
- 锁是每个 workspace 至多一条的协作记录；不会按读锁/写锁实现共享锁，也不会自动清理过期锁。
- diff 和 snapshot 生成的 patch 不包含未跟踪文件。
- 配置文件会被创建和读取，但其中的 `defaultMode`、保留期和磁盘上限目前尚未参与运行时决策。

