# ADR 0002：客户端密钥存储使用 Electron safeStorage

- 状态：已接受
- 日期：2026-10-13（阶段 1 实现时确定）

## 背景

design 5.9 要求模型密钥"永不落配置文件"，原表述为写入系统钥匙串（Windows Credential Manager / macOS Keychain）。可选实现：

1. `keytar` 等原生模块直接调用系统钥匙串；
2. Electron `safeStorage`（加密密钥由 DPAPI / Keychain 保护）加密后写入本地文件；
3. 明文 + 文件权限控制（不可接受）。

## 决策

采用 **方案 2：Electron safeStorage + 加密文件**（`~/.hu-agent/secrets.enc.json`）。

## 理由

- `keytar` 已停止维护，原生模块在 Electron 升级/交叉编译上维护成本高（单人开发尤其敏感）；
- safeStorage 的加密密钥由操作系统保护（Windows DPAPI / macOS Keychain），密文即使被复制也无法在其它机器解密，满足"密钥不落明文"的目标；
- 无原生依赖，跨平台一致。

## 后果

- 密钥保护的强度取决于操作系统账户安全（与钥匙串方案同级别）；
- `secret://keychain/<service>/<account>` 保留为引用格式，`safeStorage` 是其当前实现，未来可无痛替换为真正的系统钥匙串实现；
- 机器间迁移需要重新录入密钥（密文不跨设备），文档中已注明。
