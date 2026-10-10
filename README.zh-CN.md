# SJTU 场地监控（终端 UI）

这是一个 Python 小工具，用于轮询 SJTU 体育场馆的场地余量，并在终端里以**自动刷新**的仪表盘形式展示。

想直接在已登录的预约页面中点击选择场馆和日期？使用[油猴脚本及安装说明](USERSCRIPT.zh-CN.md)，无需复制 Cookie 到 `cookies.json`。

## 功能

- 终端自动刷新 UI（基本不滚屏）
- 循环监控多个场馆/日期组合
- 按场馆和场地类型缓存每日 `dateId` 映射，跨日运行时自动刷新日期
- 区分待检查、有余量、无余量和检查失败，展示具体场地、时段、余量及查询时间
- 新出现可用时段时的提醒：
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

1. 在 `config.py` 中配置 `TARGET_CONFIGS` 场馆列表；如有需要，也可调整 `HEADERS`。

2. 编辑项目目录中的 `cookies.json`，把浏览器里成功的场地接口请求的 Request Headers 中的**整段 Cookie**粘贴到 `cookie_header`：

```json
{
  "cookie_header": "cookie名=实际值; 另一个cookie名=实际值"
}
```

不需要单独识别某个 Cookie 名称。`cookies.json` 优先于旧环境变量，且已被 `.gitignore` 忽略，不会被普通 Git 提交。保留 JSON 的双引号；只替换引号内的 Cookie 内容。

3. （可选）在 `monitor.py` 中调整 `POLL_INTERVAL`（一整轮完成后的等待秒数）和 `CHECK_INTERVAL`（相邻请求间隔）。实际两轮间隔还包括请求耗时。

## 使用方法

直接运行：

```bash
python main.py
```

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
- **AVAILABLE SLOTS**：本轮已确认的具体场地、日期、时段、余量和查询时间
- **CHECK STATUS**：待检查、有余量、无余量和失败的数量及任务状态
- **PREPARATION FAILED / RECENT ERRORS**：日期准备失败和历史错误

当发现有余量时，会：

- 只在发现新出现的可用时段时尝试响铃，不会因同一余量持续存在而每轮重复提醒
- 在 UI 顶部显示高亮横幅

## 文件说明

- `main.py`：命令行入口与目标选择
- `monitor.py`：轮询逻辑 + 终端 UI
- `config.py`：监控目标、请求头、读取本地 Cookie 文件
- `cookies.json`：本地 Cookie 配置（请勿分享或提交）
- `date_id_cache.json`：程序自动生成/更新的本地缓存，已从 Git 跟踪中移除
- `fresh_date_ids.py`：强制刷新所有配置场馆的日期 ID（`python fresh_date_ids.py`）
- `sjtu-venue-monitor.user.js`：浏览器油猴脚本；见[安装说明](USERSCRIPT.zh-CN.md)
- `tests/test_monitor.py`：不访问网络的回归测试（`python -m unittest discover -s tests`）

## 常见问题

- **没有响铃？**
  - 很多终端默认禁用了 bell，需要在终端设置里开启。
- **请求失败 / 一直没有结果？**
  - 优先检查环境变量中的登录态，再看界面的失败状态和错误详情。
  - 如果提示 `API error 401`，请重新登录，在浏览器开发者工具的 Network 中查看 `sports.sjtu.edu.cn` 场地接口请求实际发送的整段 Cookie。你提供的两个 `_ga` Cookie 已被接口拒绝；更新 `cookies.json` 后重新启动程序。
- **太频繁/太慢？**
  - 调整 `POLL_INTERVAL`，或减少 `TARGET_CONFIGS` 的数量。

## 免责声明

本项目仅用于个人便利的余量监控，请合理使用，避免过度请求。
