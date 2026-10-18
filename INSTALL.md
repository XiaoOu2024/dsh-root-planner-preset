# 安装说明

面向**接收方**。本包是一个 DSH agent 预设（bundle），不改动 DSH 本体。

[English README](README.md) | [中文说明](README.zh.md) | [维护者文档](docs/DEVELOPMENT.md)

## 一、前置条件

装之前请对照确认，缺哪条后面都会报错：

| # | 条件 | 为什么 | 怎么确认 |
|---|---|---|---|
| 0 | **DSH ≥ `0.2.1-rc.2`** | 包里声明了 `engines.dsh`，更老的运行时会被插件管理器**拒绝安装**；而且 0.2.0 上会静默让子代理跑默认预设（人设错、工具多一倍） | `dsh --version` |
| 1 | **DSH 版本足够新**，预设中带有本包引用的那些工具行 | 本补丁**镜像了随包 `standard` 预设的工具行**；行被改名或删除会导致该预设激活失败 | 看 DSH 里是否存在 `standard` / `ptc` / `cordis` 预设；能正常用 `subagent` 工具即可 |
| 2 | **（可选）`dsh-ops`** | 子代理还会额外拿到 `ops_glob`、`ops_grep`、`ops_inspect_local_file`、`ops_replace` 这四个工具；**没有它也不影响运行**，子代理同样有 `read`/`glob`/`grep`/`write` | 装过就有，没装就没 |
| 3 | **git** 在 PATH 上 | 从 GitHub 安装时 pnpm 需要 git 拉源码 | `git --version` |
| 4 | 能访问 GitHub | 拉取仓库 | 浏览器能打开本仓库 |
| 5 | Node（**仅**跑校验脚本时需要） | 两个校验脚本用 | `node -v` |

**关于第 2 条**：子代理的工具集**不由你手改**——它等于 `root-planner-worker` 预设挂的那 15 行所提供的工具。要看某个子代理**实际**拿到了什么，用：

```sh
node tools/extract-offered-tools.mjs "<子会话目录>"
```

它读的是会话日志里注册表自己持久化的 schema，不是模型的叙述。另外有一小撮工具由 Host **全局注册**、任何预设都删不掉（0.2.1-rc.2 上是 `ops_*` 四个加 `working_directory`），所以子代理无论如何都会看到它们。

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

> 守卫是以**profile 级条目**挂载的（不是预设内的一行）。这意味着它约束**这个 profile 里的每个被委派 agent**——包括用着别的预设、从没被告知 `_agents/` 的子代理。如果你在同一个 profile 里也用别的预设加子代理，可以在 profile 补丁里关掉它：
>
> ```yaml
> - id: root-planner-guard
>   disabled: true
> ```
>
> 为什么不做成预设行（那样就只约束本预设）？试过了，**实测不生效**：配置里那一行存在且看起来正常，但真实会话上六步探针全部放行。所以 `verify-patch.mjs` 现在会在有人改回预设行时直接失败。

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
| 预设加载失败，报 **`provider "fork" does not support independent agent preset selection`** | 给 `subagent_fork` 配了 `agentPreset`。fork 提供方声明 `agentPreset: false`、且继承父上下文，配了必抛错 | 别给 fork 行配 `agentPreset`。本包只在 `subagent`（spawn）行上配；`verify-patch.mjs` 会双向断言这一点 |
| 预设加载失败，报 **`tools.restrict() names unknown global tool …`** | 说明有人把 `worker-mask` 那种限制行又加回来了。预设自己的工具注册在 agent 作用域，而 `restrict()` 只过滤**全局**工具 | 删掉那条限制行。worker 的工具集**只能**由预设挂哪些行决定，见 README「worker 的工具集」一节 |
| 预设加载失败，报 **`unknown prompt variable "{{…}}"`** | 提示词节里写了未被注册的变量（本机只注册 `provider`、`model`） | 把人设 suffix 里的变量删掉；本包已改为无变量表述，`verify-patch.mjs` 会断言两个预设的 suffix 都不含 `{{` |
| 委派立刻返回**深度错误** | `maxDepth` 没设或设得太小 | 见第三节，设为 `2` |
| 子代理拿到的**工具不对**（太少/太多） | worker 预设的行清单被改了，或根会话跑在别的预设上 | 跑 `node verify-patch.mjs` 看行断言；再用 `node tools/extract-offered-tools.mjs <子会话目录>` 读子代理**实际**被提供了哪些工具 |
| 子代理**还是能改文件** | 根会话没选中 Root Planner（见第四节），或守卫行被关掉了 | 先确认根会话带本预设的人设；再确认 `cordis.yml` 里有 `root-planner-guard` 行且 `disabled` 不为 `true` |
| 子代理**能写父目录**（越界没被拒） | 守卫只在 `origin === "subagent"` 的会话上生效；顶层会话天然不受限 | 确认那是真子代理；守卫对**文件工具**是结构性拒绝，对 shell 只能做**尽力而为**——命令里拼出来的路径它看不见 |
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

本包的**结构化行为**（worker 预设与根预设的分离、围栏、深度上限）已在 DSH 0.2.1-rc.2 上实测过：真实会话里派生 4 个子代理，各自 26 个工具（平台默认 39）、带本预设人设、越界写入被拒。

**未实测的部分**：别的操作系统、别的 DSH 版本；以及 shell 命令**运行时拼出的路径**——围栏对文件工具是结构性拒绝，对 shell 只能尽力而为，所以人设里仍然保留"父代理在子代理回报后核验边界"这一步。报告问题时请带上 `dsh --version` 与完整报错。

如果你撞上了没列在上面的错误，麻烦带上报错原文开个 issue。
