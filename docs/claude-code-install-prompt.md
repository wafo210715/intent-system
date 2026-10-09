# 帮我安装 intent-system（意图系统）内测版

请帮我在这台 Mac 上装好 intent-system 的本机服务和它的 Claude Code 插件。每一步做完都检查结果；遇到失败先告诉我原因，不要跳过。**只改下面列出的地方**，尤其是 `~/.claude/settings.json` 里已有的配置一个都不能动。

## 它是什么

intent-system 是跑在本机的服务（只监听 127.0.0.1:8723）：读我电脑上 Claude Code / Codex 的历史对话，在我提问时召回相关的历史给 Claude 参考。配套的 Claude Code 插件在输入框上方加一行开关和进度。召回的打分跑在他们的服务器上，我拿到邀请码后在它的管理页里激活。历史对话只存在本机。

## 第 1 步：检查环境

1. 确认是 macOS。
2. 确认有 Bun（`bun --version`）。没有就用官方脚本装：`curl -fsSL https://bun.sh/install | bash`，装完用绝对路径确认（通常是 `~/.bun/bin/bun`）。
3. 确认我的 Claude Code 版本 ≥ 2.1.293（`claude --version`）：低于这个版本加载不了这种插件，停下来告诉我，先升级 Claude Code 再继续。

## 第 2 步：拿代码

```bash
git clone https://github.com/wafo210715/intent-system.git ~/intent-system
cd ~/intent-system && bun install && bun test
```

`bun test` 应全部通过。`~/intent-system` 已存在的话先问我，不要覆盖。

## 第 3 步：让服务开机自动运行

用 launchd 建一个用户级常驻服务：

- 文件：`~/Library/LaunchAgents/com.intentsystem.serve.plist`
- 运行：`<bun 的绝对路径> run src/server.ts`，工作目录 `~/intent-system`（写绝对路径）
- `RunAtLoad` 与 `KeepAlive` 都为 true；标准输出与错误写到 `~/Library/Logs/intent-system.log`

然后加载并检查：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.intentsystem.serve.plist
curl -s --noproxy '*' http://127.0.0.1:8723/health
```

`/health` 应返回 JSON。8723 端口已被占用就停下来告诉我。

## 第 4 步：装 Claude Code 插件

插件在 `~/intent-system/adapters/claude-code/intent-toggle`。

1. 校验：`claude plugin validate ~/intent-system/adapters/claude-code/intent-toggle`，应通过（author 的警告可以忽略）。
2. 在 `~/.claude/settings.json` 的 `env` 里加 `"CLAUDE_CODE_PLUGIN_DIRS": "~/intent-system/adapters/claude-code/intent-toggle"`：
   - 文件或 `env` 不存在就新建；**其他键一个都不能改**；
   - 已经有 `CLAUDE_CODE_PLUGIN_DIRS` 时，用冒号把新路径追加在后面，不要覆盖；
   - 改完确认文件仍是合法 JSON，并把改动前后的 `env` 给我看。

## 第 5 步：告诉我接下来怎么做

装完后照这几句话告诉我：

1. **新开一个 Claude Code 会话**（插件只在会话开始时加载），输入 `/intent ui`，会在浏览器里打开管理页。
2. 管理页第 ① 步输入我的邀请码，点「激活」。（想用自己的 DeepSeek key：激活后在「设置 → 用哪种模型」选「自己配置：DeepSeek 官方」并粘贴 key——key 加密存在他们的服务器上，可随时删除；不填就一直用免费的 27B。）
3. **来源** 页：导入 Claude Code（有 Codex 的话也导入）；建议先按项目排除不想被召回的目录。
4. **概览** 页：打开「Claude Code」开关，之后新对话一开始就会用意图系统；单个对话里也可以用 `/intent on` / `/intent off` 切换。
5. 第一次导入后，服务器会给我的历史做一次全量预热（几千条大约要一小时，期间召回会比较慢），之后就快了。

还要告诉我两件事：

- **隐私**：历史对话只存在本机；召回时，相关的对话片段会发到他们的服务器上处理，服务器不保存这些内容。
- **提问时的样子**：每句话会被先拦下做召回（Claude Code 会按它的原生样式短暂显示一行「Prompt blocked by a hook」，不是出错），召回完原话会自动发出。
- **更新**：以后按仓库 README 的「更新」一节操作（`cd ~/intent-system && git pull && launchctl kickstart -k gui/$(id -u)/com.intentsystem.serve`，然后新开 Claude Code 会话）。
- **卸载**：`launchctl bootout gui/$(id -u)/com.intentsystem.serve`，删除 plist、`~/intent-system` 和 `~/.config/intent-system/`，再从 `~/.claude/settings.json` 去掉那一行。
