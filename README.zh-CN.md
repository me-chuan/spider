# SJTU 场地监控（终端 UI）

这是一个 Python 小工具，用于轮询 SJTU 体育场馆的场地余量，并在终端里以**自动刷新**的仪表盘形式展示。

## 功能

- 终端自动刷新 UI（基本不滚屏）
- 循环监控多个场馆/日期组合
- 使用 `date_id_cache.json` 缓存 `dateId` 映射，减少每天重复请求
- 发现余量时的提醒：
  - 终端响铃（`\a`，取决于终端是否启用 bell）
  - UI 内高亮横幅提示

## 运行环境

- Linux / macOS / Windows
- Python **3.10+**（推荐 3.11 / 3.12）
- 依赖：`requests`

安装依赖：

```bash
pip install requests
```

## 配置

1. 在 `config.py` 中配置监控目标和请求所需信息：

- `TARGET_CONFIGS`：你要监控的场馆列表
- `HEADERS` / `COOKIES`：用于访问 SJTU Sports 接口的请求头/登录态

2. （可选）在 `monitor.py` 中调整轮询间隔：

- `POLL_INTERVAL`（单位：秒）

## 使用方法

直接运行：

```bash
python main.py
```

## Tampermonkey 版本（无需手动复制 cookie）

如果你更希望在浏览器里长期挂着监控，并自动复用当前登录态，可导入 `sjtu_venue_monitor.user.js`。

1. 浏览器安装 Tampermonkey。
2. 新建脚本并粘贴 `sjtu_venue_monitor.user.js` 内容（或直接导入）。
3. 打开并保持任意 `https://sports.sjtu.edu.cn/*` 页面处于登录状态。
4. 脚本会在页面内轮询，显示悬浮面板，并在余量变化时提醒。

可直接在 userscript 内调整 `TARGET_CONFIGS`、`POLL_INTERVAL_MS`、`INTERESTING_VENUES`、`INTERESTING_HOURS`。

### 按场地类型过滤

如果你的 `TARGET_CONFIGS` 内包含 `type` 字段（不区分大小写），例如：`tennis`、`badminton`、`gym`，可以使用以下参数只监控某一类：

```bash
python main.py --tennis
python main.py --badminton
python main.py --gym
```

也可以组合：

```bash
python main.py --tennis --gym
```

如果指定了过滤条件但没有匹配任何目标，程序会输出 `No tasks to monitor. Exiting.` 并退出。

## UI 说明

仪表盘主要包含：

- 当前时间、循环次数（cycle）、总检查数（checks）
- 当前正在检查的任务（场馆 + 日期）
- **AVAILABLE NOW (court + date)**：当前检测到的可用场馆（去重）
- **TASK OUTPUT**：当前任务的最近状态信息

当发现有余量时，会：

- 尝试触发终端响铃（如果你的终端启用了 bell）
- 在 UI 顶部显示高亮横幅，并展示前几条 `(场馆 | 日期)`

## 文件说明

- `main.py`：命令行入口与目标选择
- `monitor.py`：轮询逻辑 + 终端 UI
- `config.py`：监控目标、headers/cookies
- `date_id_cache.json`：程序自动生成/更新的每日缓存
- `sjtu_venue_monitor.user.js`：Tampermonkey userscript 版本（基于浏览器登录态，无需手动复制 cookie）

## 常见问题

- **没有响铃？**
  - 很多终端默认禁用了 bell，需要在终端设置里开启。
- **请求失败 / 一直没有结果？**
  - 优先检查 `config.py` 中的 `HEADERS` / `COOKIES` 是否有效。
- **太频繁/太慢？**
  - 调整 `POLL_INTERVAL`，或减少 `TARGET_CONFIGS` 的数量。

## 免责声明

本项目仅用于个人便利的余量监控，请合理使用，避免过度请求。
