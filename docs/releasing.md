# 开源发布与在线更新配置指南

本文档说明在将 **Skill Library** 开源到 GitHub 后，如何激活应用内在线更新并发布首个支持自动更新的 Release。

## 1. 一次性的开源前配置

### 1.1 生成更新签名密钥（minisign）

Tauri 2 的在线更新强制要求使用 Ed25519（minisign）密钥签名更新包，以防止传输过程被篡改。**请务必妥善保存私钥和密码，切勿将私钥提交到 Git 仓库。**

在本地运行：

```bash
npx tauri signer generate -w ~/.tauri/skill-library.key
```

命令会生成两个文件：
- `~/.tauri/skill-library.key`：**私钥**（绝不提交到仓库，稍后写入 GitHub Secrets）
- `~/.tauri/skill-library.key.pub`：**公钥**（单行字符串，填入 `src-tauri/tauri.conf.json`）

> 如需无密码或指定密码，可在交互提示中输入密码（建议设置密码并一并保存到密码管理器与 GitHub Secrets）。

### 1.2 更新 `src-tauri/tauri.conf.json`

打开 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)，替换 `plugins.updater` 中的两处占位内容：

1. 将 `pubkey` 替换为 `~/.tauri/skill-library.key.pub` 中的完整单行公钥字符串。
2. 将 `endpoints` 中的 `OWNER/REPO` 替换为你的真实 GitHub 用户名与仓库名：

```json
"plugins": {
  "updater": {
    "pubkey": "替换为你的真实公钥",
    "endpoints": [
      "https://github.com/<你的GitHub用户名>/<你的仓库名>/releases/latest/download/latest.json"
    ]
  }
}
```

> 说明：在未替换占位配置前，仓库代码仍可正常编译和本地运行；用户在「设置 → 关于与更新」手动检查时会看到「尚未配置发布源」友好提示，启动静默检查保持安静。

### 1.3 配置 GitHub Actions Secrets

进入 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret**：

#### 必选 Secrets（用于在线更新包签名）
- `TAURI_SIGNING_PRIVATE_KEY`：`~/.tauri/skill-library.key` 文件的**完整文本内容**
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码（如未设置密码可留空或省略）

#### 可选 Secrets（用于 Apple Developer ID 签名与公证）
工作流 [.github/workflows/release.yml](../.github/workflows/release.yml) 默认采用免费 **ad-hoc 签名**（无需 Apple 付费账号即可发布）。若未来购入 Apple Developer ID，只需在 GitHub Secrets 中补充以下变量即可自动切换为正式签名与公证，无需修改代码或工作流：
- `APPLE_CERTIFICATE`（导出的 `.p12` 证书 base64 编码）
- `APPLE_CERTIFICATE_PASSWORD`（`.p12` 证书密码）
- `APPLE_SIGNING_IDENTITY`（例如 `Developer ID Application: Your Name (TEAMID)`）
- `APPLE_API_KEY`（App Store Connect API `.p8` 私钥内容）
- `APPLE_API_ISSUER`（Issuer UUID）
- `APPLE_API_KEY_ID`（Key ID）

## 2. 发布新版本流程

1. **同步更新版本号**（三处保持一致，遵循 SemVer `X.Y.Z`）：
   - [package.json](../package.json) 中的 `"version"`
   - [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) 中的 `"version"`
   - [src-tauri/Cargo.toml](../src-tauri/Cargo.toml) 中的 `version`（及提交后更新的 `Cargo.lock`）
2. **提交并推送版本标签**：
   ```bash
   git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "chore: release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```
3. **检查 GitHub Actions 与草稿 Release**：
   - 推送 `v*` 标签后，工作流会自动分别在 Apple Silicon（`aarch64-apple-darwin`）与 Intel（`x86_64-apple-darwin`）环境构建并上传：
     - 首次安装用的 `.dmg`
     - 在线更新用的 `.app.tar.gz` 与 `.app.tar.gz.sig`
     - 统一清单 `latest.json`
   - 工作流默认创建 **Draft Release（草稿）**，确认产物齐全并补充更新说明（Release Notes，建议纯文本/简洁 Markdown 列表）后，点击 **Publish release** 正式发布。
   - **重要**：不要开启 Pre-release，客户端仅从正式发布的 Latest Release 拉取 `latest.json`。

## 3. macOS 未公证构建的用户提示

在未配置 Apple Developer ID 签名与公证前，用户从 GitHub 下载 `.dmg` 安装（或在线更新替换 `.app`）后首次启动时，macOS Gatekeeper 可能提示「无法验证开发者 / 应用已损坏」。建议在项目 README 与 Release Notes 中附上说明：

- 将 `Skill Library.app` 拖入「应用程序（Applications）」目录（注意：直接从挂载的 `.dmg` 镜像里打开时无法执行在线自更新覆盖）。
- 若被 Gatekeeper 拦截，在终端执行一次：
  ```bash
  xattr -cr "/Applications/Skill Library.app"
  ```

## 4. 开源前本地联调验证（Mock 更新服务器）

无需推送到 GitHub，即可在本地开发构建中完整验证在线更新流程：

1. 在临时目录生成测试用密钥（测试完毕后删除临时目录），并准备一个测试 `.app.tar.gz` 及其 `.sig`、以及指向本地 HTTP 服务的 `latest.json`。
2. 在本地启动静态文件服务（例如 `python3 -m http.server 8787`）。
3. 通过环境变量覆盖端点与公钥启动开发应用（仅在 `debug` 模式下允许本地 `http://127.0.0.1` / `http://localhost`）：
   ```bash
   SKILL_LIBRARY_UPDATE_ENDPOINT="http://127.0.0.1:8787/latest.json" \
   SKILL_LIBRARY_UPDATE_PUBKEY="<你的测试公钥>" \
   npm run tauri dev
   ```
4. 打开「设置 → 关于与更新」点击「检查更新」，即可在真机上验证提示、下载进度、取消下载与签名校验。
