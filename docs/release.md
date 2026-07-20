# 发布指南

本项目通过 GitHub Actions 构建、验证并发布 npm 包。日常 push 和 pull request 运行 `.github/workflows/ci.yml`；符合 `v*.*.*` 的标签触发 `.github/workflows/release.yml`。

## 首次发布前配置

1. 确认 npm 上的包名 `zigma-workspace` 仍可用，并由有权发布该包的 npm 账户执行首次发布。
2. 在 GitHub 仓库创建名为 `npm-publish` 的 Environment。建议为该环境配置 required reviewers。
3. 首次发布后，在 npm 包设置中添加 GitHub Actions trusted publisher：
   - Organization or user: `LummiGhost`
   - Repository: `zigma-workspace`
   - Workflow filename: `release.yml`
   - Environment: `npm-publish`
   - Allowed action: `npm publish`
4. 为仓库的 `main` 分支启用保护规则，并将 CI 的三个 `validate` matrix job 设为必需检查。
5. 选择并添加项目许可证；在此之前不要把包描述为开源软件。

trusted publishing 使用 GitHub OIDC，不需要在仓库中保存长期 `NPM_TOKEN`。发布任务使用 Node.js 24，满足 npm trusted publishing 对 Node.js 和 npm CLI 的版本要求。

## 发布步骤

在干净的 `main` 分支上更新 `package.json` 版本并提交，然后创建完全匹配的标签。例如发布 `0.1.0`：

```powershell
npm version 0.1.0
git push origin main
git push origin v0.1.0
```

流水线会依次执行依赖安装、安全审计、类型检查、构建、CLI 冒烟测试、npm 包生成、npm 发布和 GitHub Release 创建。标签与 `package.json` 版本不一致时会立即失败。

发布前可在本地运行：

```powershell
npm ci
npm audit --omit=dev
npm run check
npm pack --dry-run
```

## 回滚原则

npm 已发布版本不可覆盖。发现问题时不要删除或移动已有标签；应修复后发布新的 patch 版本。必要时可在 npm 上 deprecate 有问题的版本，并在对应 GitHub Release 中写明替代版本。
