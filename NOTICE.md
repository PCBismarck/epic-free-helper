# 参考来源与修改说明

本项目的周免筛选和浏览器领取流程参考了以下公开项目：

- [feldorn/free-games-claimer](https://github.com/feldorn/free-games-claimer)，参考版本 2.11.17。
- 其上游项目 [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer)。

本仓库保留 AGPL-3.0-only 许可证全文，见根目录及 `browser-extension` 目录下的 `LICENSE`。上游代码的版权归其原权利人所有；此说明不声明对上游作品的版权归属。

2026-09-12 的修改采用 Chrome Manifest V3 与原生扩展 API，加入严格的零价及商品身份核验、在同一新页面稳定确认已拥有后跳过领取，以及相应的逻辑、DOM、后台与离线浏览器验证。扩展运行时不加载上述参考项目的 Node.js 或 Patchright 模块。
