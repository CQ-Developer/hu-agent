# ADR 0007：客户端主进程 ESM 化与发行包瘦身

- 状态：已接受
- 日期：2026-10-15（P6 打包与文档收尾）

## 背景

R1 切换后，客户端引擎全部使用 pi 组件。pi 的 npm 包（`@earendil-works/*`）是 **ESM-only**：
`package.json` 只有 `"type": "module"`，exports 只声明 `import` 条件（没有 `require`/`default`）。
而 electron-vite 默认把主进程构建为 CJS（app 的 package.json 无 `type: module`），外部依赖被
`externalizeDepsPlugin` 保留为 `require(...)`。

后果：打包后的应用启动即抛
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './context' is not defined by "exports"`
（`@earendil-works/chord/context` 是主进程的第一个 pi import），**应用无法启动**；
而全量测试仍然全绿——vitest 只加载 TypeScript 源码，不加载构建产物。

同时发行包体积失控：`@earendil-works/pi-coding-agent`（31 MB 解包，仅为候选 `ModelRegistry` 引入）
留在 dependencies；`pi-ai` 的依赖带入 `@google/genai` / `@aws-sdk/client-bedrock-runtime` 整条
google/bedrock SDK 链；node_modules 的 `.map`/`.d.ts`/原始 TS 源码也一并入包。
基线：`app.asar` 105 MB、`win-unpacked` 477 MB。

## 决策

1. **主进程产出 ESM**（`out/main/index.mjs`，`package.json` 的 main 指向它）。Electron 28+ 原生支持
   ESM 主进程；electron-vite 在 `output.format = 'es'` 时自动使用 `.mjs` 扩展名。源码中的
   `__dirname` 改为以 `import.meta.url` 推导。
2. **preload 保持 CJS**：`sandbox: true` 的 preload 不支持 ESM；路径不变（`out/preload/index.js`）。
3. **依赖瘦身**：dependencies 移除未被引用的 `pi-coding-agent` 与 `pi-telemetry`（后者由 pi-ai
   传递依赖保留）；`pi-mcp` 由隐式传递依赖转为显式 `1.2.0`；renderer 侧依赖（react/react-markdown
   等，构建时已被 Vite 打包）移入 devDependencies。
4. **electron-builder 排除**：pi-ai 的可选 provider SDK（`@google/genai`、bedrock）及其**独占**传递依赖
   （按 lockfile 依赖图精确计算，共 48 个包）；通用非运行时文件（`*.map`、`*.d.ts`、`openai/src`、
   `@anthropic-ai/sdk/src`）。`@smithy/node-http-handler` 等 pi-ai 的直接依赖保留。
5. **防回归冒烟**：`app/scripts/check_main_esm.mjs` 在 build 后校验「产物是 ESM」且「每个外部依赖都能按
   `import` 条件解析」，已接入 CI 的 build 步骤与 `npm run check`。
6. **NOTICE**：仓库根新增第三方组件声明（pi 组件的 MIT 正文 + 运行时依赖清单）。

## 后果

- 发行包：`app.asar` 105 MB → **16 MB**；`win-unpacked` 477 MB → **385 MB**
  （Electron 运行时约 369 MB，占大头）。
- 打包形态实测能完成 bootstrap（启动日志、登录门禁、密钥引用迁移均正常），启动级缺陷修复。
- 约束：新增 `@earendil-works/*` 依赖时保持 ESM 主进程；若未来必须回到 CJS，相关依赖需参与打包
  （`externalizeDepsPlugin({ exclude })`）或由上游提供 `require` 条件。
- `openai`（25 MB）与 `@anthropic-ai/sdk`（13 MB）仍是体积大头，但均为运行时必需。
- 同类风险提示：**单测/集成测试不覆盖构建产物**，凡是模块格式、外部依赖解析、打包排除类改动，
  必须走「构建 + 冒烟」路径。
