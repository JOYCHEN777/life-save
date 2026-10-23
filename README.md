# 随手存档 · Life Save

> 把生活里的小事记下来，之后还能找得回来。

Life Save 是一个帮助用户记录日常小事、确认已经做过什么，并在之后回看的生活工具。当前形态是可本机试用的 Web 原型，界面使用原生 HTML、CSS 和 JavaScript。

## 当前状态

这是一个**开发版原型**，不是安装包。当前版本已经可以在本机运行 SQLite 服务，并让不同浏览器共享同一份正式存档。

### 已支持

- 生活卡片、场景确认、间隔提醒和每日固定时间提醒。
- 一键记录、撤销最近一次、完成后「补一句」备注。
- 生活动态、独立随手记、记录日历和分类热力展示；随手记保存后可删除，不提供修改。
- 首页「翻翻以前」：随机回看今天之前的真实随手记或带备注记录。
- 六套预设皮肤、自定义本机壁纸、预览／应用／恢复默认。
- 本机 SQLite 正式存档：卡片、场景、记录、备注、随手记、确认轮次、提醒、外观和操作偏好都会保存。
- 旧浏览器 `localStorage` 存档迁移到 SQLite，并提供合并预览和测试存档隔离。

### 尚未支持

- 安装包、自动启动服务，以及不依赖 Node.js 的普通用户安装流程。
- 账号、云同步、好友互动和跨设备使用。
- 系统通知、完整备份管理、导出／导入中心和磁盘故障恢复。
- 补记过去的操作、修改历史操作时间和删除卡片。

## 快速开始

### 启动本机服务

需要支持 `node:sqlite` 的 Node.js；当前验证环境为 Node 22。

在项目根目录运行：

```sh
node prototype/server.mjs
```

打开 <http://127.0.0.1:8787/prototype/>。

本机服务同时提供网页和 SQLite API，默认只监听 `127.0.0.1:8787`。如果使用 Python 或其他静态服务器提供页面，SQLite 服务仍必须保持运行；页面会连接 `8787` 端口。

开发验证时可以指定端口和数据目录：

```sh
PORT=8788 LIFE_SAVE_DATA_DIR=/tmp/life-save-dev node prototype/server.mjs
```

这些命令只适用于开发和原型验证，不代表未来安装版的启动方式。

### 运行测试

```sh
cd prototype
npm test
```

当前测试覆盖数据模型、旧存档迁移、皮肤、SQLite 持久化、并发写入、幂等重试、备注冲突、测试空间和客户端错误处理。

## 数据存在哪里

正式存档独立于项目目录、Git 分支和预览端口。默认数据目录由操作系统决定：

| 系统 | 默认目录 |
| --- | --- |
| macOS | `~/Library/Application Support/Life Save` |
| Windows | `%APPDATA%/Life Save` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/life-save` |

数据库文件是目录下的 `data.sqlite`，壁纸文件保存在同一目录的 `files/`。可用 `LIFE_SAVE_DATA_DIR` 指定开发验证目录。

测试页面使用 `?check=<名称>` 进入独立存档，例如：

```text
http://127.0.0.1:8787/prototype/?check=memory-check
```

测试数据会写入数据目录下的 `tests/`，不会污染正式存档。不要把测试 URL 当成日常使用地址。

## 迁移旧浏览器存档

浏览器之间不能直接读取彼此的 `localStorage`。迁移必须在**持有旧数据的原浏览器**中执行：

1. 启动本机 SQLite 服务，并在原浏览器打开 Life Save。
2. 进入「设置」中的「迁入浏览器旧存档」。
3. 选择来源，先查看合并预览和冲突摘要。
4. 根据结果选择「合并迁入」「以来源为准」或「保留当前」。

原浏览器来源不会被删除。迁入前会在 SQLite 中保留当前存档备份，重复迁入同一来源不会重复计数；写入失败时不会覆盖原数据。

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `prototype/index.html` | 页面入口和应用布局 |
| `prototype/app.js` | 页面渲染、导航和交互 |
| `prototype/styles.css` | 响应式样式、反馈动效和主题适配 |
| `prototype/model.js` | 记录、确认轮次、提醒、日历和回忆规则 |
| `prototype/appearance.js` | 预设皮肤、壁纸校验和外观存储 |
| `prototype/sqlite-store.js` | 页面到本机 SQLite 服务的客户端 |
| `prototype/server.mjs` | HTTP 服务、SQLite 事务、迁移和测试空间 |
| `prototype/store.js` | 旧版浏览器存储兼容和迁移来源读取 |
| `prototype/*test.mjs` | 单元测试和本机服务测试 |
| `docs/product.md` | 需求、交接记录、验收结果和已知限制 |

旧版 v3/v4 浏览器存储代码仍保留在 `prototype/store.js`，仅用于迁移和回归测试；当前页面不再把浏览器存储当作正式运行时存档。

## 分支协作

- `main`：只保留已经验证、可以作为基线的版本。
- `codex/<需求编号>-<简称>`：一个需求批次一个开发分支。
- 开发分支完成测试后提交并推送，经过检查后再合并回 `main`。
- 需求讨论和实现结果统一回填到 [`docs/product.md`](docs/product.md)。

当前原型批次使用 `codex/prototype-batch` 分支；安装版仍属于后续 LS-17-B，不把开发启动命令当作安装即用交付。

## 产品文档

产品目标、需求编号、优先级、待定方案和每批实际验证结果见 [`docs/product.md`](docs/product.md)。需求讨论和代码实现分开进行，尚未定稿的候选方案不会自动进入开发范围。
