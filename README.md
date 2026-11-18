# YouTube 订阅迁移助手 (YouTube Sub Migrator)

基于 **Chrome Extension Manifest V3** 的浏览器插件，无需申请 API Key，即可将原 YouTube 账号订阅的所有频道信息一键导出（支持 **JSON 完整版** 与 **Google Takeout 标准 CSV**），并批量自动订阅到另一个 YouTube 账号。

## 核心功能

- **一键全量导出订阅频道**：自动打开 `https://www.youtube.com/feed/channels` 并滚动加载全部分页，提取频道名称、`Channel ID`、`@Handle`、频道链接、简介与头像。
- **双格式导出与兼容**：支持导出完整 JSON 文件，以及兼容 Google Takeout 的 `Channel Id,Channel Url,Channel Title` 标准三列 CSV 文件（也可直接导入从 Google Takeout 下载的 `subscriptions.csv`）。
- **后台批量自动订阅**：独立控制台页面配合后台 Service Worker 队列，自动识别中英文界面下的「已订阅 / Subscribed」状态并跳过重复项，支持调节间隔秒数、暂停、继续、停止与失败重试。

## 安装方式

1. 克隆或下载本仓库代码到本地文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions/`，开启右上角 **开发者模式 (Developer mode)**。
3. 点击左上角 **加载已解压的扩展程序 (Load unpacked)**，选择本项目文件夹。

## 使用步骤

1. **导出原账号订阅**：登录旧 YouTube 账号，点击浏览器右上角插件图标打开「YouTube 订阅迁移控制台」，点击「扫描当前登录账号的全部订阅」，完成后可下载 JSON/CSV 或保留在插件缓存中。
2. **导入到新账号**：在 YouTube 页面右上角切换到目标新账号，回到迁移控制台上传导出的 `.json` / `.csv` 文件（或点击「直接载入第一步刚扫描的列表」），确认间隔秒数后点击「开始批量自动订阅」。

## License

MIT
