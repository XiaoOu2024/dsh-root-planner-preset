# 安装说明

面向**接收方**。本包是一个 DSH agent 预设（bundle），不改动 DSH 本体。

[English README](README.md) | [中文说明](README.zh.md) | [维护者文档](docs/DEVELOPMENT.md)

## 一、前置条件

装之前请对照确认，缺哪条后面都会报错：

| # | 条件 | 为什么 | 怎么确认 |
|---|---|---|---|
| 1 | **DSH 版本足够新**，预设中带有本包引用的那些工具行 | 本补丁**镜像了随包 `standard` 预设的工具行**；行被改名或删除会导致该预设激活失败 | 看 DSH 里是否存在 `standard` / `ptc` / `cordis` 预设；能正常用 `subagent` 工具即可 |
| 2 | **本机已注册这些全局工具名** | 子代理白名单是 **allow 列表**，而 `tools.restrict()` 遇到**未知全局工具名会直接抛错、导致子代理创建失败** | 见下方清单 |
| 3 | **git** 在 PATH 上 | 从 GitHub 安装时 pnpm 需要 git 拉源码 | `git --version` |
| 4 | 能访问 GitHub | 拉取仓库 | 浏览器能打开本仓库 |
| 5 | Node（**仅**跑校验脚本时需要） | 两个校验脚本用 | `node -v` |

**第 2 条的必需工具名**（缺任何一个都要改白名单，见故障排查）：

```
read  glob  grep  read_image
ops_inspect_local_file  ops_glob  ops_grep
skill  todo_write  ask_user_question
get_goal  create_goal  update_goal
list_agents  send_message  interrupt_agent
subagent  subagent_fork
web_search  web_fetch
```

> 其中 `ops_*` 三个来自社区包 `dsh-ops`。如果你的环境没有它们，**必须**把它们从白名单里删掉——白名单在 `cordis.patch.yml` 里两个 `toolFilter.allow` 处，改完跑一次 `node verify-patch.mjs`。

## 二、安装

四种方式任选，推荐第 1 种。

### 方式 1：npm（推荐）

```sh
dsh plugin --profile web add dsh-root-planner-preset
```

已发布在 npm：<https://www.npmjs.com/package/dsh-root-planner-preset>。这是**预构建安装**，跳过 pnpm 的构建授权步骤，最省事。

> 也可以钉版本：`dsh plugin --profile web add dsh-root-planner-preset@1.0.0`

### 已内置：子代理工作区围栏

预设自带一个守卫行，**不需要另装**。它把"子代理只写自己的 `_agents/` 目录"从人设规定变成**调用级拒绝**：

- 子代理 `write` / `edit` / `ops_replace` 的目标路径落在 `_agents/` 之外 → **调用被拒，代码根本没跑**；
- 子代理的 shell 调用 `workdir` 不在工作区内、或命令里写着指向你文件的绝对路径 → **被拒**；
- 根 agent **不受限制**（它必须能在自己工作区任意位置写，才能把产物并入）。

被告拒时它收到的是一句说明边界的错误，例如：

```
write: outside your workspace. You may write only inside "...\_agents"; everything else
in the parent's directory is read-only to you. Send your parent a change request instead
of writing "...\report.md" directly.
```

**一个仍然存在的限制**：shell 命令能在运行时拼出路径（`$env:X` 拼 `'..'`、脚本内部写、Here-String），参数扫描看不见。要真正关住子代理的 shell 需要给它更窄的沙箱写域，而 DSH 给不了（`sandboxPolicy.resolve()` 只接受 `{session, mode}`，`workspaceRoot` 恒等于不可变的会话 cwd）。所以父 agent 的时间戳核验仍是兜底——人设里已经写了。

> 守卫以**预设行**形式挂载，所以只有用 `root-planner` 预设的 agent 才受约束：`_agents/` 这套约定只有这个预设的人设定义过。

### 方式 2：GitHub 源码

```sh
dsh plugin --profile web add github:XiaoOu2024/dsh-root-planner-preset
```

> 也可以指定分支或 tag：`github:XiaoOu2024/dsh-root-planner-preset#v1.0.0`

### 方式 3：让 DSH 里的 agent 装

对 agent 说：

> 用 `plugin_manager` 的 `install_bundle`，target 填 `dsh-root-planner-preset`（或 `github:XiaoOu2024/dsh-root-planner-preset`）

注意：这个工具调用需要 **Full access** 权限或当次授权。

### 方式 4：先克隆再按路径装

```sh
git clone https://github.com/XiaoOu2024/dsh-root-planner-preset
```

然后让 agent 用 `install_bundle`，target 填**克隆下来的绝对路径**。

装完重启 `dsh web`。

### ❌ 不适用：插件市场界面

**「设置 → 插件市场」搜不到本包，属正常。** dsh-market 只允许安装 `awesome-dsh-plugin` 精选列表内的来源，本包不在其中。请用上面三种方式。

## 三、装完必做：设置深度

进入 **设置 → 子智能体 → 深度上限**，填 **`2`**。

- **为什么必须手动做**：`maxDepth` 是 Host 设置，**不属于本 bundle**——本包故意不在工具行上写死它，否则会把你以后调高的值悄悄压回去。
- **数值含义**：`2` = 根(0) → 子代理(1) → 孙代理(2)，只有 depth 1 能再派，depth 2 是叶子。
- **不要填 `0`**：那会禁掉全部委派，本预设的设计直接失效。
- 填 `1` 也能跑，但子代理就不能再派了，中间层失去作用。

## 四、启用与验证

1. **开一个新会话**（已有会话和它的子代理会保留启动时的插件版本，不会变）。
2. 在预设选择器里选 **Root Planner**。

   > ⚠️ **这是最容易踩的坑：根会话必须真的选中 Root Planner。** 有人实测时根会话仍是 `standard`，结果整棵树的行为都对不上——根不受本预设任何规则约束，而它派出的子代理却是 `root-planner`，于是"谁的权限是什么"完全错位，最后据此得出一堆关于预设的错误结论。**怎么确认**：会话文件 `~/.dsh/sessions/<cwd>/<session-id>/session.v4.jsonl.zstd` 的第一行里有 `"agentPreset":"root-planner"` 字段；写着 `standard` 就是没选中。

3. 派一个研究任务，确认两件事：

   - 子代理的工具列表里**没有** `write`、`edit`、`ops_replace`、`ops_bash`、`pwsh`；
   - 子代理**能**再派一层，而它的子代理**不能**（会返回深度错误）。

4. （可选）在克隆下来的目录里跑校验：

   ```sh
   node verify-patch.mjs
   node verify-depth-override.mjs
   ```

   两条都应输出 `ALL CHECKS PASSED`。第二条在没配深度覆盖的机器上会打印 `SKIP` 并说明原因——那是正常提示，不是失败。

## 五、故障排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 预设列表里**没有 Root Planner** | bundle 没装上，或预设行激活失败（会带诊断留在名册上） | 看 DSH 的插件/加载诊断；多半是第 1 条前置不满足——本包的补丁引用了随包预设里不存在的工具行 |
| DSH **启动失败**（进程直接退出） | DSH 启动是全有全无，一个插件加载失败整个进程就退出 | 用插件市场的「**调整插件**」恢复界面：DSH 点名的插件会标红并默认取消勾选，勾好再启动。找不到该界面时，手工编辑 profile 的 `cordis.patch.yml` 把对应行设为 `disabled: true` |
| 子代理创建失败，报 **`tools.restrict() names unknown global tool …`** | 白名单里有**不是全局工具**的名字。注意有两种情况：①你的环境根本没注册该工具；②它是**agent 作用域**工具（如 `subagent`，它注册在每个被组合 Agent 自身的作用域里），而 `toolFilter` **只接受全局工具名** | 报错里会列出该环境全部的全局工具名，照着它删掉白名单里那几个不存在的名字。白名单在 `cordis.patch.yml` 的两个 `toolFilter.allow` 处（或在 `child-tools.mjs` 里改后重跑生成器），改完必须重开会话 |
| 委派立刻返回**深度错误** | `maxDepth` 没设或设得太小 | 见第三节，设为 `2` |
| 子代理**什么都不能读** | 白名单过窄（比如你删过头了） | 至少保留 `read`、`glob`、`grep`、`ops_inspect_local_file`、`ops_glob`、`ops_grep` |
| 子代理**还是能改文件** | 根会话没选中 Root Planner（见第四节），或白名单被改坏了 | 先查会话文件的 `agentPreset` 字段是否 `root-planner`；再确认 `cordis.patch.yml` 里两处 `toolFilter.allow` 都**不含** `write`、`edit`、`ops_replace`、`ops_bash`、`pwsh`。改完必须重开会话 |
| 行为与人设描述**对不上**（比如"子代理能写"、"规则没生效"） | 最常见的原因就是**根会话跑在别的预设上**，而它的子代理跑在 root-planner 上——两者的规则和权限本来就不一样 | 跑 `node tools/verify-session.mjs <会话目录>`，它会判定根与全部子会话的预设、深度与父子关系 |
| 改了 `persona.txt` 但没生效 | 会话与子代理都锁定启动时的插件版本 | 开**新会话**；必要时把 `preset-root-planner` 在插件列表里关掉再打开 |
| Windows 上校验报**人设不一致** | 换行符被 Git 改写了 | 确认 `.gitattributes` 存在且含 `* text=auto eol=lf`，重新克隆一次 |

## 六、卸载

**推荐**：让 agent 调 `plugin_manager` 的 `remove_bundle`，target 填 `dsh-root-planner-preset`。它会同时处理包和 profile 清单里的登记，最干净。

**命令行备选**：

```sh
dsh plugin --profile web remove dsh-root-planner-preset
```

⚠️ 但注意：命令行的 `remove` 是**直接透传给 pnpm** 的（插件管理器只接管 `add`/`install`/`i`），所以它**只删包，不会清理** profile 的 `dsh.profile.bundles` 里的登记。用命令行卸载后，建议检查一下 `~/.dsh/profiles/<你的 profile>/package.json` 的 `dsh.profile.bundles` 数组，手工删掉残留条目，否则下次启动可能因找不到包而报错。

卸载后**不影响**你已经设过的深度上限——那是 Host 设置，不是本包带来的。

## 七、一个诚实的提醒

本包**尚未在作者环境之外实测过子代理运行**——白名单里的工具名是按作者环境的实际工具清单交叉核对出来的。所以第 2 条前置条件务必先对照一遍，尤其是 `ops_*` 那几个（它们来自社区包 `dsh-ops`，不是 DSH 自带）。

如果你撞上了没列在上面的错误，麻烦带上报错原文开个 issue。
