# intent-system（意图系统客户端）

把你电脑上的历史对话变成「意图召回」：你问一句话，它从 Claude Code / Codex 的历史里找出真正相关的原文片段，整理成上下文交给 Claude 参考——「上次那个怎么弄的」不再需要重新解释。

- 一个跑在**你电脑上**的本地服务（只监听 127.0.0.1，不对外），历史对话**只存在本机**；
- 召回的「理解与打分」跑在**我们的服务器**上（需邀请码，免费）：召回时，提问与相关历史片段会发到我们的服务器处理，**服务器不保存这些原文**（用完即弃，磁盘上只留计数字节与缓存对齐参数）；
- 配套 Claude Code 插件：输入框上方一行开关 + 召回进度 + 「回答前确认」卡，召回结果作为 Claude 读得到、你界面上看不到的上下文附在旁边。

**需要邀请码**：内测期间由我们发放（联系我们获取）。没有邀请码暂时用不了。

**两种模型方式**（管理页「设置」里切换）：

| | 用我们的服务器（27B） | 自己配置：DeepSeek 官方 |
| --- | --- | --- |
| 费用 | 免费 | 你自己的 DeepSeek 账户承担（低谷一次全量召回约几元、高峰约翻倍，以 DeepSeek 后台为准） |
| 需要什么 | 邀请码激活即可 | 邀请码激活 + 你的 DeepSeek API key（在设置里填一次） |
| key 怎么存 | — | **加密存在我们的服务器上**（不落日志、只用于你的召回、可随时删除）；本地不留副本 |
| 缓存预热 | 首次导入后自动预热（约 6–12 条/秒，1,000 条约 2–3 分钟，以管理页预计为准） | 不需要预热 |

两种方式的理解与打分流程都在我们的服务器上运行，客户端不下发。

## 支持范围（先看这里）

| 环境 | 支持 |
| --- | --- |
| macOS + Claude Code 终端版 ≥ **2.1.293** | ✅ |
| macOS + Claude 桌面版的 **Code 标签页**（会话里能跑 `/intent` 的那种） | ✅ |
| Claude Code **2.1.276 及更早** | ❌ 加载不了本插件（引擎缺插件 API） |
| Claude 桌面版 **Cowork** | ❌ 它跑在虚拟机沙盒里，读不到本机插件、连不上 127.0.0.1 |
| Codex（OpenAI）| 历史可以被召回 ✅；在 Codex 里触发召回还没接 |

## 安装（约 5 分钟）

**省事的做法**：把 [`docs/claude-code-install-prompt.md`](docs/claude-code-install-prompt.md) 整份复制给你的 Claude Code，它会按步骤装好并自检。

**手动安装**：

1. 准备：[Bun](https://bun.sh)（`curl -fsSL https://bun.sh/install | bash`）。
2. 拿代码并自检：

   ```bash
   git clone https://github.com/wafo210715/intent-system.git ~/intent-system
   cd ~/intent-system && bun install && bun test
   ```

   `bun test` 应全部通过。
3. 启动服务（只监听 `127.0.0.1:8723`）：`bun run serve`。
   想开机自动运行：用 launchd 建 `~/Library/LaunchAgents/com.intentsystem.serve.plist`，`ProgramArguments` = `<bun 绝对路径> run src/server.ts`，`WorkingDirectory` = `~/intent-system`，`RunAtLoad` / `KeepAlive` 为 true，然后 `launchctl bootstrap gui/$(id -u) <plist 路径>`。
4. 装 Claude Code 插件：在 `~/.claude/settings.json` 的 `env` 里加一行（已有这个键就用冒号**追加**，其他配置一个都不动）：

   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "~/intent-system/adapters/claude-code/intent-toggle"
   ```

   **新开**一个 Claude Code 会话后生效（插件只在会话开始时加载）。

## 第一次用

新开一个 Claude Code 会话，输入 `/intent ui`：浏览器打开管理页 `http://127.0.0.1:8723/ui`。没激活时整个页面就是一个三步向导，跟着走完即可：

1. **① 激活**：输入我们发给你的邀请码，点「激活」。
2. **② 选择来源并导入**：选要导入的应用（Claude Code / Codex）；可以先按项目排除**不想被召回**的部分（排除只是不参与召回，数据还在，随时恢复）。导入前页面会给出预热的预计时间。
3. **③ 自动预热**：导入完自动开始，进度和剩余时间在概览与「来源」页都能看；完成后会提示可以在 Claude Code 里提问。之后只增量预热新对话，很快。预热速度实测约 6–12 条/秒（1,000 条约 2–3 分钟），**以管理页给的预计为准**。

> **想用自己的 DeepSeek key**：激活后到「设置 → 用哪种模型」选「自己配置：DeepSeek 官方」，粘贴一次 key 即可（详见上面两种模式对照表）。这档不需要预热——向导第 ③ 步会直接显示就绪。

三步走完后，**概览**：打开「Claude Code」开关 = 之后的新对话一开局就用意图系统。

## 在 Claude Code 里怎么用

输入框上方的按钮条：

| 按钮 | 作用 |
| --- | --- |
| **会话：开 / 关** | 本对话里每句话要不要走意图系统（开着时每句先过门卫，寒暄、短确认会跳过） |
| **本问：强制分析** | 只对下一句：跳过门卫，必做分析 |
| **新会话默认：开 / 关** | 和管理页概览的「Claude Code」开关是同一个 |
| **管理** | 打开管理页 |

开着的时候问一句话：**这句先被拦下** → 同步本机新对话 → 召回（按钮条上是阶段条和进度）→ 有拿不准的连接时弹**回答前确认卡**（对 / 不对 / 改字 / 补一句背景）→ **原话自动发出**，召回结果作为「模型读得到、你界面上看不到」的一段附在旁边给 Claude 参考。

> 拦下原话的那一瞬间，Claude Code 会按它的原生样式显示一行红色的「Prompt blocked by a hook」——这不是出错，是插件的正常机制（先召回、召回完自动重发原话），之后会自动继续。

命令：`/intent`（看状态）、`/intent on|off`、`/intent force`、`/intent default on|off`、`/intent ui`。命令只在本机执行，不发给模型。

其他情况：

- **缓存还没预热完**：提问时先弹一张卡让你选——不做意图分析直接发送 / 仍然召回（会很慢）/ 开始预热 / 取消。
- **出错或中断**（服务重启、断网、45 秒没有任何输出）：按钮条显示原因，「重试（接着上次的进度）」只补没做完的；也可以「不做意图分析，直接发送」或「取消」。
- **桌面版**：新对话要等你输入第一句（或 `/intent`）才启动；进入一个没在运行的对话，按钮条要等 Claude Code 本身启动完（约 3 秒）才出现。
- **上下文文件**：每个会话的召回结果会累积写在 `~/intent-system/data/context/<会话id>/context.md`（管理页「概览 → 最近召回」点开也能看到路径）；注入块末尾会带这个路径，Claude 需要时可以用 read 工具读全文。

## 数据与隐私

- **数据都在本机**：导入的历史、召回记录、表态、上下文文件在本仓库的 `data/`（已 gitignore）；配置与授权在 `~/.config/intent-system/`（与同名私有实验版互不影响）。
- **发到哪里**：召回时，提问与相关历史片段会发到我们的服务器做理解与打分；服务器**不保存**这些内容（处理在内存里完成，磁盘上只有计数字节与缓存对齐参数）。导入本身不上传。
- **邀请码激活**会把这台电脑的专属密钥写进 `~/.config/intent-system/hosted.json`（权限 600）；换电脑先在管理页「解除授权」把名额让出来。

## 更新

```bash
cd ~/intent-system && git pull && launchctl kickstart -k gui/$(id -u)/com.intentsystem.serve
```

然后**新开**一个 Claude Code 会话（插件只在会话开始时加载）。

## 卸载

停服务（launchd：`launchctl bootout gui/$(id -u)/com.intentsystem.serve`，并删 plist）→ 删仓库目录 → 从 `~/.claude/settings.json` 去掉 `CLAUDE_CODE_PLUGIN_DIRS` 那一行 →（可选）删 `~/.config/intent-system/`。用我们的服务器的话，先在设置里「解除授权」。

## 常见问题

- **每问先出现一行红色「Prompt blocked by a hook」**：不是出错——插件先拦下这句做召回，召回完会自动把原话发出（见上），等几秒就好。
- **按钮条显示「intent-lab 没有运行」**：`cd ~/intent-system && bun run serve`（服务名沿用了组件名 intent-lab；按钮条与命令 `/intent` 不变），或检查 launchd 日志。
- **新对话里看不到按钮条**：桌面版要等第一个输入；先输 `/intent`。
- **召回特别慢**：看管理页「来源」的预热覆盖率；没到 100% 时召回不命中缓存。
- **一直停在某一步**：45 秒没有输出会自动标为中断；点「重试（接着上次的进度）」。
- **改了插件文件**：已打开的会话会重新加载插件，正在跑的召回会中断（之后可重试接着跑）；平时别改。

## 开发

- `bun install && bun test`（后端测试，全 mock 不打真实模型）；插件测试：`claude plugin test adapters/claude-code/intent-toggle`。
- 本机接口与管理页见 `src/server-core.ts` 的路由；对外的服务器只有两个地址：激活服务与模型网关（都在管理页激活流程里自动使用，不需要手填）。

## 许可证

MIT（见 [LICENSE](LICENSE)）。模型与召回服务由我们提供，需邀请码；服务端实现不开源。
