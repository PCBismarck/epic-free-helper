# Epic 周免领取助手

面向 Windows Chrome / Edge 的 Epic 周免领取扩展，支持一键领取、已拥有游戏跳过和每日定时检查。

在浏览器中登录 Epic，安装扩展后即可使用。当前版本为 **1.0.2**。

## 功能

- **检查本周免费游戏**：从 Epic 官方促销接口获取当前有效的 PC 周免游戏。
- **自动领取**：核验商品身份和零元价格后完成领取，并重新打开商品页确认入库。
- **跳过已拥有游戏**：确认商品页显示“已在库中”后，继续检查下一款。
- **每日定时检查**：可开启每天北京时间 23:35 自动运行。
- **进度与结果展示**：在扩展弹窗中查看每款游戏的状态，随时停止任务。

## 安装

1. 下载并解压本仓库源码，保留解压后的目录。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择仓库中的 `browser-extension` 目录，其中应直接包含 `manifest.json`。
5. 在同一浏览器中登录 Epic，点击扩展图标，再点击“领取本周游戏”。

更新扩展文件后，在扩展管理页点击“重新加载”。

## 使用说明

定时检查默认关闭。本轮全部游戏确认已领取或已拥有后，即可在弹窗中开启定时。浏览器需要保持运行；关闭浏览器或电脑休眠时，任务无法按时执行。

每轮使用一个领取标签页，依次检查最多 10 款游戏，最长运行 5 分钟。遇到需要登录、人工验证或无法识别的页面时，任务暂停并关闭定时，保留标签页供处理。处理完成后点击“停止本次任务”，再手动运行。

## 隐私与权限

登录由 Epic 网站处理，扩展使用浏览器当前的登录状态，不收集密码或导出 Cookie。设置、任务进度和游戏结果保存在浏览器的扩展本地存储中。

扩展使用 Chrome Manifest V3，申请 `alarms`、`storage`、`scripting`、`webNavigation` 权限，页面访问范围限定为 Epic 域名。

## 开发与测试

开发环境需要 Node.js 22 或更新版本。在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm test
```

测试包含 121 项领取逻辑及 DOM 检查、14 项后台生命周期检查，使用模拟数据验证零价筛选、入库确认、已拥有跳过、任务取消和调度行为。

另提供可选的离线 Chromium 检查，运行完整的弹窗、后台和页面流程，验证两款已拥有游戏依次跳过，且获取与提交点击均为零。脚本使用独立的临时浏览器目录以及本地页面、促销数据。

该检查需要 Linux 的 systemd 用户服务和 cgroup v2，并在启动前核验资源限制。在仓库根目录执行：

```sh
npx --no-install patchright install chromium
systemd-run --user --unit=epic-owned-skip-check --collect --wait --pipe \
  -p MemoryMax=2G -p MemorySwapMax=0 -p TasksMax=256 \
  -p CPUQuota=150% -p RuntimeMaxSec=75 \
  --working-directory="$PWD" node "$PWD/scripts/check-owned-skip.mjs"
```

临时数据和测试报告保存在 `.local/`，已由 `.gitignore` 排除。

## 许可证

[AGPL-3.0-only](LICENSE)。开源来源及修改说明见 [NOTICE.md](NOTICE.md)。
