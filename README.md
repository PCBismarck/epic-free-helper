# Epic 周免领取助手

在已经登录 Epic 的 Windows Chrome / Edge 中，检查并领取官方 Epic PC 周免游戏。当前版本为 **1.0.2**，采用 Chrome Manifest V3。

## 安装和使用

1. 下载源码并解压，保留安装目录。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”，选择本仓库的 `browser-extension` 子目录。
4. 在同一浏览器中登录 Epic，点击扩展图标，再点击“领取本周游戏”。更新文件后须在扩展管理页点击“重新加载”。

扩展沿用浏览器现有的 Epic 登录状态，无需配置账号密码、模型 API 密钥，也无需导出 Cookie。扩展运行时不需要 WSL、Node.js、Python、Docker 或 Patchright；Node.js 和下述依赖只用于开发验证。

每轮最多创建一个领取标签页，顺序检查当前官方 PC 周免游戏，最长运行 5 分钟。已拥有的游戏仍会打开商品页核对当前账号；在同一新页面稳定确认“已在库中”后，显示“已拥有·已跳过”并继续下一款，不点击领取或额外刷新。新领取的游戏须刷新商品页确认入库才记为成功。

扩展只允许经过核验的零元商品。遇到登录、人工验证或无法识别的页面时会停止，关闭定时并保留任务标签页，供用户处理。处理后点击“停止本次任务”，再手动运行。

定时默认关闭，只有本轮全部游戏确认已领取或已拥有后，才能开启“每天 23:35 自动检查”（北京时间）。浏览器必须开启；电脑休眠或浏览器关闭期间无法按时执行。扩展不会自动处理验证码，也不会反复重试失败的任务。

## 源码范围与本地数据

本仓库包含扩展源码、测试、一个不含账号信息的商品卡片样例，以及可选的离线浏览器检查脚本。不包含旧方案的配置、账号密码、Cookie 导出、浏览器用户目录或运行记录。

扩展将设置、当前任务和游戏结果保存在当前浏览器的扩展本地存储中，不写入源码目录。开发验证生成的临时浏览器目录和报告位于 `.local/`，已由 `.gitignore` 排除。该仓库也不包含第三方登录凭据或模型服务配置。

## 开发验证

需要 Node.js 22 或更新版本。安装依赖并运行逻辑、DOM 与后台生命周期检查：

```sh
npm ci --ignore-scripts
npm test
```

当前验证基线为 121 项逻辑及 DOM 测试、14 项后台模拟检查。这些检查不会启动浏览器，也不会访问真实 Epic 账号。

另有离线 Chromium 检查，通过扩展弹窗、后台、页面引擎和真实 Chrome 扩展 API，验证两款已拥有游戏依次跳过。测试使用独立临时浏览器目录、本地页面和促销数据，拦截页面外部请求；不使用个人浏览器登录状态。验证目标为每款只打开一次商品页、获取与提交点击均为零。

此可选检查需要 Linux 的 systemd 用户服务和 cgroup v2；脚本会核验内存、交换空间、进程数和 CPU 限制，不接受无资源限制的直接启动。在仓库根目录执行：

```sh
npx --no-install patchright install chromium
systemd-run --user --unit=epic-owned-skip-check --collect --wait --pipe \
  -p MemoryMax=2G -p MemorySwapMax=0 -p TasksMax=256 \
  -p CPUQuota=150% -p RuntimeMaxSec=75 \
  --working-directory="$PWD" node "$PWD/scripts/check-owned-skip.mjs"
```

报告保存在 `.local/epic-free/owned-skip-browser-check.json`。离线测试不代表当前 Epic 网站和用户账号上的完整领取流程已经通过；Windows 上的新版完整流程仍需重新加载扩展后实际核验。

## 许可证与参考来源

源码采用 [AGPL-3.0-only](LICENSE)。参考项目及修改说明见 [NOTICE.md](NOTICE.md)。
