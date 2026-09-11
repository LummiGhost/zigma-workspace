# 消费者 × Provider 兼容矩阵

本文记录哪些消费者以何种契约表面消费 zigma-workspace，以及各自的激活门
（gate）、所需能力与可复现证据。协商语义见
`docs/platform-integration-contract.md` §13；矩阵中的“证据”一列是测试文件
与 CI 编排的权威指针，状态一列表示该消费路径当前的验证状态。

## 矩阵

| 消费者 | Provider / 契约版本 | 所需能力 | 激活门 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Core M0 adapter（zigma-core `src/adapters/zigma-workspace-cli.ts`） | `zigma-workspace` CLI，`contract_version` 1 | `REQUIRED_WORKSPACE_CAPABILITIES`（M0 集合：create/bind-run/diff/snapshot/cleanup/heartbeat/reconcile/integration-lock/strict-cleanup/isolation-policy） | `contract-info --json` 后校验 version/provider/能力，缺失即 fail closed（Core 侧硬编码 M0 列表，与托管集合无关，互不影响） | `tests/adapters/m0-real-cli.contract.test.ts`（env-gated 真实 CLI）+ `npm run test:m0-cross-repo` | 已激活（M0） |
| Flow 托管 bridge（zigma-flow `src/workspace/zigma-workspace-cli-provider.ts`，M3.5 PR） | `zigma-workspace` CLI，`contract_version` 1 | `managed_required_capabilities`（prepare-run/prepare-job/commit/integrate/publish/strict-cleanup/reconcile/heartbeat/cleanup；列表只来自 provider 响应，Flow 不硬编码） | `ZIGMA_WORKSPACE_CLI_PATH` 已设置 且 `contract-info`（或 `negotiate --role managed`）返回 `managed_supported === true` 且能力完整；字段缺失/为 false/版本不符 → 抛类型化错误，托管工作流 fail closed，禁止静默降级 | `tests/workspace/zigma-workspace-cli-provider.test.ts`（stub CLI 单测）+ `tests/workspace/managed-real-cli.contract.test.ts`（env-gated 真实 CLI）+ zigma-core `npm run test:m3-cross-repo`（真实 Flow+workspace 全链路） | M3.5 落地中（workspace → flow → core 三 PR 依序合并） |
| Consumer 进程黑盒 harness（zigma-workspace `tests/consumer/`） | 已构建的 `dist/cli/index.js`（每次运行以 mtime 判定并在缺失/过期时自动重建），`contract_version` 1 | 与所测命令一致：negotiation 测试用 `MANAGED_REQUIRED_CAPABILITIES`；生命周期/soak 测试覆盖全部托管能力 | 仅跨 spawn 边界调用 built dist；`beforeAll` 自动构建；无 env gate（workspace CI 三平台始终运行） | `tests/consumer/negotiation.test.ts`、`tests/consumer/managed-lifecycle.test.ts`、`tests/consumer/cancellation-soak.test.ts`；workspace CI 的 `pnpm check` job | 已激活（M3.5） |

## 规则

1. 契约版本必须为 `1`（严格数字比较；字符串 `"1"` 视为不支持）。
2. provider 必须是 `zigma-workspace`。
3. 托管激活依赖 `managed_supported === true`；字段缺失（旧 CLI）一律
   fail closed。
4. 能力列表以 provider 响应为准，消费者不得硬编码托管能力集；M0 列表由
   Core 单独维护，与托管集合互不派生。
5. 协商失败不得静默降级为 external/directory 模式。
6. 矩阵更新须同步指向新的测试文件与 CI job，并保持状态列真实。

## 跨仓库 CI 证据（M3.5）

zigma-core 的 `npm run test:m3-cross-repo` 编排以下序列，其通过输出即
M3.5 的 CI 证据：

1. 构建 zigma-workspace（`dist/cli/index.js`）与 zigma-flow；
2. 以真实 contract-info/negotiate 输出同时喂给 Core 的 M0 校验器与
   workspace 的托管校验器，断言两者对同一（含篡改变体）输入给出
   一致的接受/拒绝（防列表分叉）；
3. env-gated vitest：真实 Flow CLI 经托管 bridge 调用真实 workspace CLI，
   完成 invoke → abort → quiescence ack → reconcile → strict cleanup。

操作员需在 Flow provider profile 的 `environment` 中设置
`ZIGMA_WORKSPACE_CLI_PATH`（指向 workspace CLI）与
`ZIGMA_WORKSPACE_STATE_DIR`（状态目录）。
