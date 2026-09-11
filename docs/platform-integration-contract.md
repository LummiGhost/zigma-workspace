# Zigma Workspace 平台集成契约

- 状态：M0 基线，已接受
- 契约版本：`workspace.contract_version = 1`
- 实现基线：`@zigma-ai/zigma-workspace` `0.1.5`
- 所有者：Zigma Workspace

## 1. 目的和边界

本文定义 `zigma-core`、`zigma-flow` 和宿主进程可以依赖的 Workspace
能力边界。它覆盖 workspace 创建、绑定、查询、锁、心跳、差异、快照、
对账、清理，以及 M3.3 稳定的 Run/Job attempt 生命周期（prepare、commit、
integrate、publish），并明确哪些能力已经是稳定 CLI 契约，哪些仍是
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

machine envelope 的唯一协议通道是 **stdout**：无论成功还是已分类的命令失败，
stdout 都恰好输出一个 JSON document，且不包含日志、进度或人类诊断。stderr
只可用于 envelope 之外的进程/宿主诊断，Core 不得依赖它来解析 provider 结果。
调用方必须先解析 stdout，再校验 `contract_version`，未知主版本必须拒绝，不能
根据包版本或 stderr 文本猜测兼容性。

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
| contract-info | 稳定 | - | 只读握手；不创建 state directory、数据库、镜像或 worktree |
| create | 稳定 | 稳定 | 创建独立 worktree 和 registry 记录 |
| bind-run | 稳定 | 稳定 | 绑定 task/flow run，重复绑定需满足状态约束 |
| status/list | 稳定 | 稳定 | 返回 registry 状态、路径、Git 基线和协作锁 |
| lock/unlock | 稳定 | 稳定 | 多读或单写；获取在 SQLite transaction 中完成 |
| heartbeat | 稳定 | 稳定 | 校验 owner；过期或 owner 不符时失败 |
| diff/snapshot | 稳定 | 稳定 | 受 manifest 过滤；产物带 SHA-256 digest |
| cleanup | 稳定（基础及 `--strict`） | 稳定（基础及 strict） | strict 模式验证目录和 registration，且要求 operation id |
| reconcile | 稳定 | 稳定 | 对账 registry、目录、HEAD、manifest 和 operation journal |
| integration lock | 稳定 | 稳定 | 独占、owner 校验、过期接管和心跳 |
| prepare-run | 稳定 | 稳定 | 创建或采用 `flow/<runId>` Run workspace；operation-id 幂等；`expected_base` CAS；崩溃重试采用既有 workspace |
| prepare-job | 稳定 | 稳定 | 从精确 `expected_run_head` 创建或采用 `job/<runId>/<jobId>/a<attempt>` attempt workspace；校验 Run 归属和 HEAD 血缘 |
| commit | 稳定 | 稳定 | operation-id 幂等；`expected_state`/`expected_head` CAS；结果携带 evidence artifact descriptor |
| integrate | 稳定 | 稳定 | 串行集成进 Run workspace；integration lock；`expected_head` CAS；结构化冲突证据；冲突恢复 prior Run HEAD |
| publish | 稳定 | 稳定 | `none`/`branch` 策略；`expected_head` CAS；结果携带 base/head/resulting commit、changed files 和 artifact |

Run workspace 分支为 `flow/<runId>`；Job attempt 分支为
`job/<runId>/<jobId>/a<attempt>`。attempt 分支使用同级的 `job/` 命名空间，
因为 Git 禁止同名的 branch 和 branch-directory 并存
（`refs/heads/flow/<runId>` 与 `refs/heads/flow/<runId>/<jobId>/a<attempt>`
不能同时存在）。

### 3.1 Provider handshake

调用方在执行任何会产生副作用的命令前，应运行：

```text
zigma-workspace contract-info --json
```

该命令只返回一个 stdout V1 envelope，且不得调用 `setup()`、读取配置、打开
SQLite、创建 state directory、执行 Git 或创建工作区。`data` 字段使用 CLI 的
snake_case 命名：

```json
{
  "provider": "zigma-workspace",
  "package_version": "0.1.5",
  "contract_version": 1,
  "capabilities": [
    "workspace-create-v1",
    "workspace-bind-run-v1",
    "workspace-diff-artifact-v1",
    "workspace-snapshot-artifacts-v1",
    "workspace-cleanup-v1",
    "workspace-heartbeat-v1",
    "workspace-reconcile-v1",
    "workspace-integration-lock-v1",
    "workspace-strict-cleanup-v1",
    "workspace-isolation-policy-v1",
    "workspace-prepare-run-v1",
    "workspace-prepare-job-v1",
    "workspace-commit-v1",
    "workspace-integrate-v1",
    "workspace-publish-v1"
  ]
}
```

`package_version` 用于兼容矩阵和诊断，不能替代 `contract_version`。Core 应将
能力名视为稳定标识：未知主契约版本或缺少所需 capability 时，必须在 create、
bind-run、diff、snapshot、cleanup 之前 fail closed。新增 V1 可选能力不应使旧
调用方失败。

### 3.2 Run/Job attempt 生命周期（M3.3）

Flow 按以下顺序消费 provider 操作：

1. `prepare-run`（operation id `run:<runId>:create`）创建或采用 Run
   workspace，分支 `flow/<runId>`，状态推进到 `RUNNING`。`--expected-base`
   提供创建前 CAS；重试相同 operation id 回放首次结果，崩溃重试采用已拥有
   该分支的 workspace。采用（adopt）已存在的 workspace 时，`expected_base`
   与 manifest 的创建基线 commit 做大小写不敏感比较（manifest 不可读时回退
   到 registry 记录的 `base_commit`），不一致抛 `WORKSPACE_HEAD_CONFLICT`。
2. `prepare-job`（operation id `run:<runId>:job:<jobId>:attempt:<n>:create`）
   从精确的 `expected_run_head`（完整 40 位 SHA，且必须是当前 Run HEAD 的
   祖先）创建 attempt workspace。attempt 分支属于同级的 `job/` 命名空间；
   同一 attempt 的 workspace 被复用时校验其 `base_commit` 与
   `expected_run_head` 一致。所有 SHA 比较大小写不敏感。
   创建 workspace 时 manifest 文件 `.zigma-workspace.json` 自动写入该仓库
   `info/exclude`（通过 `git rev-parse --git-path info/exclude` 定位，linked
   worktree 读取的是 common dir 下的文件），因此它不会出现在 `git status`、
   diff、commit 或 evidence 中。
3. Job 完成后 `commit` 提交全部变更；结果携带 `head_commit`、
   `changed_files` 和 evidence artifact descriptor。
4. `integrate` 把 Job commit 串行合并进 Run workspace：先获取 target 的
   integration lock，再以 `expected_head` CAS 三方合并。成功的 integrate
   会把 target 留在 `MERGED`；下一次 integrate 隐式经过
   `MERGED → RUNNING` 恢复串行周期，调用方不需要额外的推进步骤。
5. 合并冲突时 provider abort 合并、把 Run workspace 恢复到集成前 HEAD，并
   返回结构化 `WORKSPACE_INTEGRATION_CONFLICT`（details 携带
   `source_commit`、`previous_target_head` 和 `conflict_files`）。Job
   workspace、commit 和 snapshot 全部保留。相同 operation id 重放同一冲突
   envelope，不重复产生副作用。
6. 全部集成完成后 `publish` 按 `none`（只记录 evidence）或 `branch`
   （推送目标 ref）策略交付，`expected_head` CAS 保护，结果携带
   `resulting_ref`、`resulting_commit`、`changed_files` 和 evidence
   artifact。`branch` 策略的 target ref 必须是裸分支名：拒绝 `refs/` 前缀
   并通过 `git check-ref-format refs/heads/<target>` 校验，防止逃逸到
   `refs/tags/*` 等命名空间。push 崩溃重试时（ref 已指向目标 commit），
   evidence 以目标 ref 之前的位置（或 manifest 创建基线）为基准计算。

`commit`/`integrate`/`publish` 与 `prepare-run`/`prepare-job` 同样要求
operation id 和规范化输入；输入哈希变化触发 `OPERATION_ID_CONFLICT`。

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

V1 artifact descriptor 的精确 schema 为：

```ts
interface ArtifactDescriptorV1 {
  id: string; // snapshot artifacts only; diff.patch_artifact omits this field
  kind: "metadata" | "patch" | "log" | "report" | "generated-file"; // snapshot artifacts only
  uri: string; // absolute file: URI produced by pathToFileURL
  media_type: "application/json" | "text/x-diff";
  digest: `sha256:${string}`; // 64 lowercase hexadecimal characters
}

interface DiffDataV1 {
  patch_artifact: Omit<ArtifactDescriptorV1, "id" | "kind"> | null;
}

interface SnapshotDataV1 {
  artifacts: ArtifactDescriptorV1[];
}
```

`diff.patch_artifact` is `null` when no tracked patch was produced; otherwise
it has `media_type: "text/x-diff"`. `snapshot.artifacts` always has one
metadata descriptor and adds one patch descriptor only when tracked changes
exist. `digest` hashes the exact UTF-8 bytes written to the referenced file;
consumers must verify it before use.

`commit`、`integrate` 和 `publish` 结果中的 evidence `artifact` 字段遵循同一
descriptor schema（`uri`、`media_type: "text/x-diff"`、`digest: sha256:<hex>`），
CLI JSON 使用 snake_case `media_type`，TypeScript API 使用 camelCase
`mediaType`。没有 evidence 内容（如 no-op commit）时为 `null`。

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
6. `integrate` 成功后 target 处于 `MERGED`；下一次 `integrate` 隐式经过
   `MERGED → RUNNING` 恢复串行周期。`CONFLICT → MERGING` 同样合法，用于
   冲突解决后的 retry-merge。`MERGING → RUNNING` 是非冲突失败（如锁冲突、
   evidence 写入失败）后的恢复边：integrate 失败时把 target 恢复为集成前
   状态并 `reset --hard` 到原 HEAD，相同或新 operation id 均可重试；`abort`
   也允许 `MERGING`/`CONFLICT → RUNNING`。

## 6. 幂等和并发

`create`、`bind-run`、`snapshot` 和基础 `cleanup` 的 CLI 支持
`--operation-id`；prepare-run、prepare-job、commit、integrate、publish 和
strict cleanup 都要求 operation id 和规范化输入。

| 情形 | 结果 |
| --- | --- |
| 相同 operation id、相同规范化输入、首次已完成 | 返回首次持久化结果，不重复副作用 |
| 相同 operation id、不同输入 | `OPERATION_ID_CONFLICT` |
| 两个进程同时提交相同 operation id | SQLite reservation 阻止重复副作用；竞争者收到显式 `OPERATION_PENDING`，不得当作成功 |
| 进程在 reservation 后崩溃 | CLI 返回 `OPERATION_PENDING`；v0.3 API 的 operation journal 保留 `started`，调用方必须 reconcile，不能盲重做 |
| 不同 operation id 请求同一非并发安全变更 | 由状态 CAS 或 lock 拒绝其中一个 |

调用方重试必须复用 operation id。因超时生成新 id 会把一次逻辑操作变成两次
不同请求，Workspace 不保证去重。CLI 调用方收到 `OPERATION_PENDING` 时必须把
结果视为未决，退避并通过 status/reconcile 查询，不得报告成功或换用新 id 盲重做。

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

6. 周期性执行 `gc`（先 plan，确认后 apply）作为所有权与保留的收口步骤：
   sweep 过期锁、按保留策略回收 abandoned/failed workspace、reclaim 孤儿
   worktree。见 §9.3。

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

`cleanup --strict --operation-id <id>` 与 `cleanupWorkspaceStrict` 提供以下语义：

- 要求 operation id；
- 删除失败返回 `status: "CLEANUP_FAILED"`、`removed: false` 和 blockers；
- registration 或目录仍存在时不得写入 `CLEANED`；
- 相同 operation id 重试返回原结果；
- Windows 文件占用必须可诊断。

修复 blocker 后如需重新执行删除，应使用新的 operation id；原 operation id 始终重放首次结果。

基础 `cleanup` 暂为兼容路径；平台编排器必须协商并使用 strict capability。

### 9.3 垃圾回收（gc）

Capability：`workspace-gc-v1`。命令 `gc --json`（默认 dry-run，零副作用）与
`gc --apply --json`。职责范围是回收，不覆盖取消/恢复协议（§8）。

语义：

- 资格分类：`ARCHIVED`/`CLEANED` → `never`；有 active 协作锁或未过期
  integration lock → `blocked`（永不打扰）；`FAILED`/`CONFLICT` 超过
  `retainFailedDays` → `failed`；`CLEANUP_FAILED` 且有历史 `gc:` 尝试 →
  无条件重试；非终态超过 14 天（硬编码 `ABANDON_DAYS`）且无锁 → `abandoned`。
- `--apply` 先 sweep 过期锁行（`expires_at <= now`），再逐候选重新读取、
  重新评估、reconcile、strict-clean（`force: false`）；评估后出现新锁 →
  `skipped ("lock_conflict")`。孤儿 worktree（git 注册但 registry 无记录）
  一并 reclaim；孤儿没有 journal 行（按定义 registry 无记录）。
- 证据保留：registry 行、operation journal、幂等记录、事件全部保留；只删除
  目录与 worktree registration。
- operation id 确定性生成 `gc:<workspaceId>:cleanup`，失败尝试追加 `:<n>`
  后缀，重试是真实执行；`gc:` 前缀不会与 Flow 的 UUID operation id 冲突。
- 并发：同一时间只运行一个 `gc`（better-sqlite3 串行化；文档约定）。

编排器建议周期：定期（如每小时）`gc --json` 计划 → 按策略决定 → `gc --apply
--json` 执行；执行后核对 `results`/`orphan_worktrees` 与 reconcile。

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

## 11. Workspace isolation policy

协商 `workspace-isolation-policy-v1` 后，Provider 在任何文件系统副作用前执行以下检查：

- workspace、repository cache、snapshot 和 artifact 必须位于配置的 state roots 内；
- 使用真实路径校验拒绝 `..`、绝对路径、symlink/junction escape 和 Windows case-fold alias；
- workflow `spec.allowedPaths` / `spec.deniedPaths` 会写入 manifest，并在 commit 前对全部 tracked、untracked、rename 和 delete 路径 fail closed；
- read-only workspace 可以生成 diff/snapshot 证据，但不能 commit、作为 integration target 或 publish；
- `config.json` 的 `maxDiskGb` 和 `retainFailedDays` 会出现在 status/reconcile capacity 结果中；容量不足返回确定性的 `WORKSPACE_CAPACITY_EXCEEDED`；
- 同一 repository 的 active workspace 不得复用 branch，且每个 workspace path 由唯一 workspace id 派生。

错误 message 供人阅读，自动化只能分支处理 code 和结构化 details。

## 12. Provider 证据和已知缺口

当前 provider test 归属：

- `tests/core/contracts.test.ts`：顺序集成、同线冲突恢复、幂等、CAS、对账、
  strict cleanup 和 integration lock；使用真实临时 Git repository。
- `tests/core/contracts-windows.test.ts`：Windows 文件句柄、路径、cleanup blocker、
  重试和并发边界。
- `tests/core/workspace-dogfood.test.ts`：worktree 隔离、manifest 过滤、多读单写、
  snapshot 和 cleanup 的真实 Git 流程。
- `tests/core/run-job-lifecycle.test.ts`：prepareRun/prepareJob 幂等与采用、
  commit/integrate/publish CAS 串行化、同线冲突恢复和 evidence artifact、
  并发 Run/Job 压力；真实临时 Git repository。
- `tests/cli/json-contract.test.ts`：真实 CLI stdout envelope、artifact、operation-id、
  heartbeat、reconcile、integration lock、strict cleanup，以及
  prepare/commit/integrate/publish 完整生命周期和冲突 envelope 黑盒契约。

仍需关闭的契约缺口：

1. 为 Core adapter 建立独立 consumer 进程的
   黑盒契约测试（当前 CLI 生命周期测试仍运行在同一仓库的测试进程内）。
2. 统一 README、CLI 和 API 的状态名，淘汰旧的小写展示语义。
3. 对 workspace root、junction/symlink 和 Windows 大小写路径增加逃逸测试。
4. 增加取消后“子进程退出 -> 句柄释放 -> reconcile -> strict cleanup”的长时
   soak test。
5. 为跨宿主 artifact URI 增加持久化 store；在此之前 `file:` 仅限本机。

这些缺口不削弱本文对当前行为的描述；它们限制的是哪些能力可以在 M0 后立即
作为稳定跨进程协议使用。
