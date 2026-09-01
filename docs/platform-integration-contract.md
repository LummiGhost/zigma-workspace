# Zigma Workspace 平台集成契约

- 状态：M0 基线，已接受
- 契约版本：`workspace.contract_version = 1`
- 实现基线：`@zigma-ai/zigma-workspace` `0.1.5`
- 所有者：Zigma Workspace

## 1. 目的和边界

本文定义 `zigma-core`、`zigma-flow` 和宿主进程可以依赖的 Workspace
能力边界。它覆盖 workspace 创建、绑定、查询、锁、心跳、差异、快照、
对账和清理，并明确哪些能力已经是稳定 CLI 契约，哪些仍是 M3 前的
TypeScript API 能力。

Workspace 拥有以下事实：

- workspace registry、路径和 Git worktree registration；
- workspace 生命周期、操作日志和幂等记录；
- workspace lock、integration lock 和 lease；
- diff、snapshot、commit、integrate、publish 和 cleanup 结果；
- registry、文件系统和 Git 状态之间的对账结论。

Core 拥有容量、调度和重试决策；Flow 拥有单次执行的步骤状态；宿主拥有
子进程等待、超时、取消和回收。调用方不得绕过 Workspace registry 后再把
自行推断的状态写回为权威状态。

## 2. 兼容性和版本协商

CLI 的每个 `--json` 响应都必须包含：

```json
{
  "contract_version": 1,
  "ok": true,
  "data": {}
}
```

失败响应保持同一 envelope：

```json
{
  "contract_version": 1,
  "ok": false,
  "error": {
    "code": "WORKSPACE_LOCK_CONFLICT",
    "message": "...",
    "details": {}
  }
}
```

兼容规则：

1. 调用方必须拒绝未知的主契约版本。
2. 版本 1 可以增加可选字段和新的错误码；调用方必须忽略未知字段。
3. 删除字段、改变字段含义、改变幂等边界或把成功改为失败需要新主版本。
4. 包版本不能代替契约版本协商；Core 的兼容矩阵必须同时约束包版本和
   `contract_version`。
5. TypeScript API 返回 camelCase；CLI JSON 返回 snake_case。跨进程调用只
   依赖 CLI JSON 字段。

## 3. 当前可依赖表面（M0）

| 能力 | CLI v1 | TypeScript API | 当前保证 |
| --- | --- | --- | --- |
| create | 稳定 | 稳定 | 创建独立 worktree 和 registry 记录 |
| bind-run | 稳定 | 稳定 | 绑定 task/flow run，重复绑定需满足状态约束 |
| status/list | 稳定 | 稳定 | 返回 registry 状态、路径、Git 基线和协作锁 |
| lock/unlock | 稳定 | 稳定 | 多读或单写；获取在 SQLite transaction 中完成 |
| heartbeat | 未暴露 | 可用 | 校验 owner；过期或 owner 不符时失败 |
| diff/snapshot | 稳定 | 稳定 | 受 manifest 过滤；产物带 SHA-256 digest |
| cleanup | 稳定（基础） | 稳定（基础及 strict） | 基础 CLI 必须检查 `removed`；strict API 验证目录和 registration |
| reconcile | 未暴露 | 可用 | 对账 registry、目录、HEAD、manifest 和 operation journal |
| integration lock | 未暴露 | 可用 | 独占、owner 校验、过期接管和心跳 |
| commit/integrate/publish | 未暴露 | 可用 | operation-id、CAS 和结构化冲突结果 |

“可用”表示当前实现和 provider tests 已存在，但在 M3 完成前不能被远程
编排器当作稳定 CLI 协议。M3 的目标不是重新定义这些语义，而是把必要能力
暴露为版本化 CLI/API，补齐跨进程契约测试和取消恢复闭环。

## 4. 标识、路径和产物

### 4.1 标识

- workspace id 使用 `ws_` 前缀；snapshot 使用 `snap_`；锁分别使用
  `lock_` 和 `ilock_`。
- `operation_id` 由调用方生成，推荐 UUID；其作用域是同一 Workspace state
  directory 中的操作日志。
- task id、flow run id 和 Core operation id 是关联字段，不替代 workspace id。

### 4.2 路径

- CLI JSON 中的 `path` 是宿主原生绝对路径，不是 URI。
- Windows 路径可以包含盘符和反斜杠；POSIX 路径以 `/` 开头。调用方必须用
  平台路径库处理，不能按 `/` 或 `\\` 手工拆分。
- 路径比较必须先解析为绝对路径，并遵循宿主文件系统的大小写规则。
- Workspace 创建的目录必须位于配置的 workspace root 内；调用方提供的相对
  路径、`..` 或符号链接不得借此逃逸 root。
- 不得把一个宿主返回的原生路径直接交给另一宿主使用。跨宿主传递产物应使用
  artifact descriptor。

### 4.3 产物

diff/snapshot 的可移植引用为：

```json
{
  "uri": "file:///absolute/path/to/artifact.patch",
  "media_type": "text/x-diff",
  "digest": "sha256-..."
}
```

`file:` URI 只在同一宿主有效。跨宿主系统必须上传到持久化 artifact store，
替换为该 store 的 URI，并保留 `media_type` 和 digest。消费者在使用前验证
digest；路径存在不等于产物完整。

## 5. 生命周期

规范化生命周期如下：

```text
CREATED -> PREPARING -> READY -> RUNNING -> WAIT_REVIEW -> MERGED -> CLEANED
   |            |         |         |          |             |
   +----------> FAILED <---+---------+----------+-------------+
                                \-> MERGING -> CONFLICT
READY/RUNNING/CONFLICT -------------------------------> ARCHIVED
CLEANUP_FAILED --------------------------------------> CLEANED or FAILED
```

当前 CLI 文档中的小写状态是展示层；registry/API 使用大写状态。调用方应按
返回值处理，不能自行拼写或通过目录是否存在推断生命周期。

关键规则：

1. `create` 成功的判据是 registry、manifest、目录和 Git worktree registration
   全部建立；部分创建由 reconcile 识别为 incomplete/orphaned。
2. `bind-run` 只建立关联并推进合法状态，不授予写权限。
3. `diff` 和 `snapshot` 是读取操作，不改变写入所有权。
4. `cleanup` 只有在目录和 Git registration 均确认移除后才能进入 `CLEANED`。
5. `CLEANED` 是终态；同一 workspace id 不可重新激活。

## 6. 幂等和并发

`create`、`bind-run`、`snapshot` 和基础 `cleanup` 的 CLI 支持
`--operation-id`；commit、integrate、publish 和 strict cleanup API 也要求
operation id。

| 情形 | 结果 |
| --- | --- |
| 相同 operation id、相同规范化输入、首次已完成 | 返回首次持久化结果，不重复副作用 |
| 相同 operation id、不同输入 | `OPERATION_ID_CONFLICT` |
| 两个进程同时提交相同 operation id | SQLite reservation 阻止重复副作用；当前 CLI 的竞争者可能读到内部 `{"__pending":true}` sentinel，这是已知协议缺口，不能当作成功 |
| 进程在 reservation 后崩溃 | CLI 幂等表可能遗留 pending sentinel；v0.3 API 的 operation journal 保留 `started`，调用方必须 reconcile，不能盲重做 |
| 不同 operation id 请求同一非并发安全变更 | 由状态 CAS 或 lock 拒绝其中一个 |

调用方重试必须复用 operation id。因超时生成新 id 会把一次逻辑操作变成两次
不同请求，Workspace 不保证去重。M3 前，CLI 调用方若收到不符合版本化 envelope
的 pending sentinel，必须把它当作“结果未决”，退避并通过 status/reconcile 查询，
不得报告成功。M3 必须用显式 `OPERATION_PENDING` 或有界等待替代 sentinel 外泄。

## 7. 写隔离、锁和 lease

### 7.1 Workspace 协作锁

- 多个 read lock 可以共存；write lock 与任何 active lock 冲突。
- 获取锁和冲突检查在同一 SQLite transaction 中。
- 获取新锁时会删除已过期锁；`heartbeat` 校验 owner 和 active lease。
- 普通 `unlock` 当前按 workspace 释放锁，不提供 owner 级 CLI CAS。自动化写入方在
  M3 前应优先使用 integration lock API，或确保只有锁拥有者调用 unlock。

### 7.2 Integration lock

- target workspace 的集成操作使用独占 integration lock。
- 同一 owner 可重入并刷新心跳；不同 owner 在 lease 有效时得到
  `WORKSPACE_LOCK_CONFLICT`。
- 只有过期 lease 可以接管。显式 takeover 仍需再次验证其已过期。
- release 校验 owner；错误 owner 得到 `WORKSPACE_LOCK_OWNER_MISMATCH`。
- 心跳晚于 expiry 不会恢复原 lease；调用方必须停止写入、重新对账，再决定接管
  或放弃。

### 7.3 写入边界

manifest 的 `allowed_paths`/`denied_paths` 当前约束 Workspace 的 diff、snapshot
和提交选择，不是操作系统沙箱。`read-only` 目前也只是 Git 配置标记。宿主仍
必须把写进程的 cwd 设置为分配的 workspace，拒绝 workspace root 外路径，并
通过进程权限或沙箱实现强隔离。

同一 repository 的并行写任务必须使用不同 workspace path 和 branch。任何两个
写任务共享目录都违反契约，即使它们持有不同逻辑锁。

## 8. 取消、恢复和对账

Workspace 没有权终止 Flow 或宿主子进程。取消协议为：

1. Core 请求 Flow/宿主取消，并停止分配新工作。
2. 宿主终止并等待进程树；stdout/stderr 与 JSON 协议流必须隔离。
3. 写进程完全退出后，调用方停止 heartbeat 并释放锁。
4. 调用 `reconcileWorkspace` 核对 registry、目录、 Git HEAD、manifest 和 journal。
5. 根据 `complete`、`incomplete`、`orphaned` 或 `inconsistent` 结果选择重试、
   人工修复或 strict cleanup。

进程退出码、Flow 的 cancelled 状态或 Core 的 terminal 状态都不能单独证明
workspace 已停止写入或已完成清理。Windows 上还必须等待子进程释放文件句柄，
否则 strict cleanup 返回 blocker，并保持非 `CLEANED` 状态。

## 9. 清理语义

### 9.1 当前基础 CLI

`cleanup --json` 返回 `removed` 和 `message`。只有 `removed: true` 时当前实现才
写入 `CLEANED`。调用方仍必须同时检查：

- JSON envelope `ok`；
- `data.removed`；
- 后续 `status`/reconcile；
- 目录与 Git worktree registration。

“命令进程退出 0”不等于物理清理已完成。重复清理已清理 workspace 时返回
`removed: false` 和 “already cleaned”，这是幂等终态，不是新的删除证据。

### 9.2 Strict cleanup

`cleanupWorkspaceStrict` 是 M3 目标语义：

- 要求 operation id；
- 删除失败返回 `status: "CLEANUP_FAILED"`、`removed: false` 和 blockers；
- registration 或目录仍存在时不得写入 `CLEANED`；
- 相同 operation id 重试返回原结果；
- Windows 文件占用必须可诊断。

M3 应把 strict cleanup 暴露为稳定 CLI，并让基础 `cleanup` 迁移到同一语义。

## 10. 错误分类和重试策略

| 类别 | 错误码 | 默认策略 |
| --- | --- | --- |
| 输入/版本 | `INVALID_INPUT`, unknown contract version | 不重试，修正调用方 |
| 不存在 | `WORKSPACE_NOT_FOUND`, `WORKSPACE_DIRECTORY_NOT_FOUND` | reconcile 后决定恢复或清理 registry |
| 幂等冲突 | `OPERATION_ID_CONFLICT` | 不重试，调查 id 复用 |
| 并发冲突 | `WORKSPACE_LOCK_CONFLICT`, `WORKSPACE_STATE_CONFLICT`, `WORKSPACE_HEAD_CONFLICT` | 退避、刷新状态、复用原 operation id |
| lease | `WORKSPACE_LOCK_OWNER_MISMATCH`, `WORKSPACE_LOCK_EXPIRED` | 停止写入并 reconcile；不得直接续写 |
| Git/集成 | `GIT_ERROR`, `WORKSPACE_INTEGRATION_CONFLICT` | 保留冲突证据，abort/reconcile 后人工或策略处理 |
| 不完整 | `WORKSPACE_OPERATION_INCOMPLETE` | reconcile 后恢复 |
| 清理 | `WORKSPACE_CLEANUP_FAILED` | 保留 workspace 和 blockers，释放句柄后重试 |
| 内部 | `INTERNAL_ERROR` | 有界重试；重复失败升级人工处理 |

错误 message 供人阅读，自动化只能分支处理 code 和结构化 details。

## 11. Provider 证据和已知缺口

当前 provider test 归属：

- `tests/core/contracts.test.ts`：顺序集成、同线冲突恢复、幂等、CAS、对账、
  strict cleanup 和 integration lock；使用真实临时 Git repository。
- `tests/core/contracts-windows.test.ts`：Windows 文件句柄、路径、cleanup blocker、
  重试和并发边界。
- `tests/core/workspace-dogfood.test.ts`：worktree 隔离、manifest 过滤、多读单写、
  snapshot 和 cleanup 的真实 Git 流程。
- `src/cli/index.ts`：实现 operation-id reservation 和 JSON envelope；当前缺少
  独立 CLI 黑盒契约测试，因此只把已列出的 CLI 子集视为 M0 基线。

M3 前仍需关闭的契约缺口：

1. 把 heartbeat、reconcile、integration lock 和 strict cleanup 暴露为 CLI v1。
2. 为 Workspace CLI 和 Core adapter 建立针对真实 CLI JSON 的 provider/consumer
   黑盒契约测试。
3. 禁止 CLI 暴露 idempotency pending sentinel；改为显式 pending 错误或等待首次
   执行的持久化结果。
4. 统一 README、CLI 和 API 的状态名，淘汰旧的小写展示语义。
5. 对 workspace root、junction/symlink 和 Windows 大小写路径增加逃逸测试。
6. 增加取消后“子进程退出 -> 句柄释放 -> reconcile -> strict cleanup”的长时
   soak test。
7. 为跨宿主 artifact URI 增加持久化 store；在此之前 `file:` 仅限本机。

这些缺口不削弱本文对当前行为的描述；它们限制的是哪些能力可以在 M0 后立即
作为稳定跨进程协议使用。
