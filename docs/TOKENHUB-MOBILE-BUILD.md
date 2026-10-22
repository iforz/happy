# Work / TokenHub 移动构建交接

范围是 `packages/happy-app` 的 Expo iOS / Android 客户端，不是独立的 `packages/happy-ios` / `packages/happy-android` 原生工程。这里记录 self-hosted 构建隔离和 Mac 后续打包门槛，不代表已经生成、签名或安装移动安装包。

## 已有值与尚缺输入

已检查仓库公开的 Expo、Android Gradle、iOS `project.yml`、Tauri 与部署配置。没有找到可以确认属于当前用户的 iOS Bundle ID 或 Android application ID；只有上游 `com.slopus.happy.*`、`com.ex3ndr.happy` 等标识。不得使用这些上游值，也不得根据站点域名猜测或派生自有包名。

| 必需输入 | 构建参数 / 交接项 | 当前状态 |
| --- | --- | --- |
| 明确开启 self-hosted | `EXPO_PUBLIC_SELF_HOSTED=1` | 必须显式设置；未开启时保留上游构建行为 |
| 移动构建目标 | `HAPPY_BUILD_TARGET=native` | self-hosted 默认值也是 `native` |
| 自有 iOS Bundle ID | `HAPPY_IOS_BUNDLE_IDENTIFIER` | 未找到，需要用户确认其自有标识；无值或使用上游命名空间立即失败 |
| 自有 Android application ID | `HAPPY_ANDROID_PACKAGE` | 未找到，需要用户确认其自有标识；无值或使用上游命名空间立即失败 |
| Work 服务 HTTPS origin | `EXPO_PUBLIC_HAPPY_SERVER_URL` | 现有网页配置使用 `https://ai.iforz.cn`；这不证明移动 TokenHub 路由已部署，需另行确认 |
| 构建变体 | `APP_ENV=production`，或 `preview` / `development` | 自有包名不会因变体自动加后缀；若需并装，由用户提供每个变体的不同标识 |
| iOS 签名身份 | 用户自有 Apple Developer Team ID，以及匹配该 Bundle ID 的签名 / provisioning 配置 | Mac 打包前由用户确认；本轮未读取、申请、创建或更改证书与账号 |
| Android 签名身份 | 该应用自有的 keystore / alias 与本地受控签名配置 | 正式可分发包需要；本轮未读取或生成密钥，不在聊天或仓库保存口令 |

两个应用标识都必须提供，即使本次只导出一个移动平台。标识检查覆盖语法和已知上游命名空间，不证明注册、归属或应用商店可用性。

移动 Work URL 必须是 HTTPS origin，不允许账户口令、路径、查询参数、片段或 HTTP loopback。构建检查不访问该地址，也不证明 TLS、网络或服务功能可用。

## self-hosted 配置隔离

`app.config.js` 调用独立 helper，只有 `EXPO_PUBLIC_SELF_HOSTED=1` 时执行以下覆盖：

- iOS / Android 使用上述两个显式自有标识，不继承上游应用身份。
- 关闭 Expo Updates：`enabled=false`、`checkAutomatically=NEVER`、`useEmbeddedUpdate=true`。删除上游 update URL、channel header、runtimeVersion 和更新签名配置；启动只能使用该安装包内嵌代码与资源。
- 移除 `owner` 和 `extra.eas` 的上游 EAS project 关联，不自动建立新 EAS 项目。
- 不声明上游 `app.happy.engineering` universal links / Android app links。
- 移除上游 `googleServicesFile`、显式远程通知插件配置、现有 APNs entitlement / 远程通知后台模式引用，以及上游 ElevenLabs agent ID。
- 不沿用开发变体的 ATS arbitrary-loads 放宽；本地网络权限本身不代表允许 HTTP Work origin。
- 保留 `happy://` scheme，兼容当前 `happy://tokenhub/callback` 认证契约。没有擅自变更回调或服务端路由。

远程 push 尚未配置或验收。Expo 预构建仍可能自动加载已安装的通知模块、添加通用 entitlement / permission；本轮清除的是上游项目 / 凭据文件引用，不承诺原生推送功能已被完全移除。自有 APNs / FCM、通知权限及生成的 entitlement 必须在后续单独审查，不能复用上游文件或账户。

`eas.json` 仍是上游发布配置，不得直接使用现有 `submit` profile、`--auto-submit`、`release:*` 或 OTA 发布脚本为自有应用发布。这里没有修改该文件、访问发布账号，或申请新的项目 / 凭据。后续如需 EAS 或商店提交，必须先确认用户自有目的地与身份，遵守仓库发布流程，不能把当前分支默认为允许发布的分支。

## Mac 前的只读配置检查

先在 Mac 的受控构建环境中设置用户已确认的三个值，不把密钥、token 或口令写入任何 `EXPO_PUBLIC_*` 参数。以下命令只检查配置，不创建原生工程、不签名、不提交：

```sh
: "${HAPPY_IOS_BUNDLE_IDENTIFIER:?请先设置用户确认的自有 iOS Bundle ID}"
: "${HAPPY_ANDROID_PACKAGE:?请先设置用户确认的自有 Android application ID}"
: "${EXPO_PUBLIC_HAPPY_SERVER_URL:?请先设置确认的 Work HTTPS origin}"
export HAPPY_IOS_BUNDLE_IDENTIFIER HAPPY_ANDROID_PACKAGE EXPO_PUBLIC_HAPPY_SERVER_URL
export APP_ENV=production EXPO_PUBLIC_SELF_HOSTED=1 HAPPY_BUILD_TARGET=native
export EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1
export EXPO_PUBLIC_DISABLE_ANALYTICS=1
pnpm --filter happy-app exec expo config --type public --json
```

输出应具有两个已确认的自有标识和 `platforms: ["ios", "android"]`；`updates.enabled` 必须为 `false`。不应出现上游 owner、EAS project ID、OTA 地址、Google services 文件或关联域名。

不要复用以前为上游应用生成的 `ios/` / `android/` 工程或安装包。后续原生工程生成与打包前，需要先按仓库发布 / 构建流程审查分支、工作区、目标和已有生成工程，再确认生成的 Info.plist、AndroidManifest、entitlements、更新配置与 application ID 都匹配本次 self-hosted 配置。本轮未执行 prebuild，不能用公共 Expo 配置检查代替原生工程检查。

## 现有网页流程不需要伪造移动标识

`scripts/local-web/config.mjs` 与 `production-config.mjs` 为网页显式设置 `HAPPY_BUILD_TARGET=web`。生产网页、loopback 网页和 `build-work-runtime.mjs` 通过现有公共配置继承这一目标，不需要填写移动标识。

- web-only 配置声明 `platforms: ["web"]`，不输出 iOS Bundle ID / Android package，也不继承上游 OTA / owner / EAS project。
- 仅 web-only 本地开发允许 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]` origin；远程 HTTP 仍拒绝。
- 不能把 `HAPPY_BUILD_TARGET=web` 用作绕过移动身份检查的开关。若 `EAS_BUILD_PLATFORM` / `EXPO_OS` 指向移动平台，配置立即失败；Expo 原生 mod guard 也会拒绝 web-only 的原生预构建。Expo export 会拒绝导出未声明的移动平台。
- 插件可能为 web 公共配置补入部分平台通用字段，但它们不构成 native application identity。

## 云端已验证与 Mac 待验收

本轮可离线重跑：

```sh
node --test packages/happy-app/scripts/selfHostedBuildConfig.test.cjs \
  scripts/local-web/config.test.mjs scripts/local-web/production-config.test.mjs
```

配置检查覆盖：

- self-hosted helper 不修改 legacy 输入；native 显式标识、HTTPS origin 与上游服务配置清理。
- 真实 `expo config --type public` 在 development / preview / production 三个 self-hosted 变体解析成功。
- 真实 CLI 对缺少 iOS ID、缺少 Android ID、上游 ID、不安全 Work origin、web-only 冒充 EAS iOS 构建返回失败。
- 三个非 self-hosted 变体保留原标识、owner、OTA / EAS 配置。
- 现有网页环境隔离、公开配置与路由检查通过；web-only native mod guard 在隔离测试中拒绝两个移动平台。

测试中的 `invalid.example.work.fixture` 和 `https://work.example.invalid` 仅是不可用于交付的隔离 fixture，不是用户自有应用身份或可用服务。检查未读取 Google services、证书或密钥文件，也未调用真实 TokenHub / 模型 API。

Mac / 真机验收仍须完成：

1. 两个平台生成、编译、签名并安装自有应用，核对最终原生标识 / 更新设置 / entitlement；具体签名与发布动作需在其获准范围内执行。
2. 验证 Release 包无 Metro 服务时启动，飞行模式冷启动能打开本地 UI，不依赖上游 OTA。离线时网络功能失败不应触发回退到上游账户或服务。
3. 按 [移动端验收清单](TOKENHUB-MOBILE.md) 验证登录、浏览器回跳、取消、后台恢复、退出及流式传输。
4. 重点测试与原版 Happy 同时安装的场景：两者共享 `happy://`，系统可能交给另一应用。自有包名只解决应用身份冲突，不解决 scheme 抢占。若有冲突，先协调自有 scheme / HTTPS 回调与服务端契约，不在客户端单方面改协议。
5. 检查通知权限、远程 push 未配置时的降级体验；不要将当前状态报告为推送或商店发布已完成。

这些云端配置测试和 JS 导出不等于 iOS / Android 原生构建、签名、安装、真机登录或离线冷启动验收。
