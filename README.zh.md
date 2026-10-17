# dsh-root-planner-preset

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 agent 预设：**把「决策」和「干活」分开**。

根 agent 的上下文装计划与决策；阅读、改文件、跑命令交给子代理，子代理回报摘要。**子代理是有工具的工人**——它有 `write`、`edit` 和 shell；唯一不许留下的是**还在跑的进程**。

> 根负责决策，工人负责干活，没有任何东西能活过任务本身。

[English](README.md) | [安装步骤](INSTALL.md) | [维护者文档](docs/DEVELOPMENT.md)

## 它解决什么问题

用 coding agent 干长任务，上下文很快被原始文件内容和命令输出塞满，于是忘了目标、丢了计划、开始重复劳动。常见对策「让 agent 多派子代理」会朝两个相反方向失败：**没有手的子代理什么也干不了**，每一步都被推回根；而**没有边界的子代理群**会随手改任何文件、还会给你留下一堆跑着的服务。

本预设走中间那条线：**有工具的工人，边界是它的任务。**

| 要求 | 机制 | 强度 |
|---|---|---|
| 子代理能读、**能改文件、能跑命令** | 两个委派工具的白名单**包含** `write`、`edit`、`ops_replace`、`pwsh` | 这是授予而非限制——没有工具的工人不算工人 |
| 子代理不能留下运行中的进程 | 预设的 `pwsh` 行设 `enableRunInBackground: false`：后台调用被拒，**且 `run_in_background` 参数被从工具 schema 里移除** | **结构性**——任何深度的模型都够不到"脱离进程"这个能力 |
| 谁都不跑无界服务 | 根与子代理的人设规则 | 提示词级，覆盖 schema 管不到的部分（`ops_bash` 没有任务注册表） |
| 子代理只在自己的工作区里写 | 人设规则：只写 `_agents/<label>/` 之下，父目录文件对它只读，越界改动以申请形式提交 | 提示词级，由父 agent **核验**（见下） |
| 委派层数由用户配置 | 运行时深度上限（`subagent.maxDepth`） | **结构性**：超过上限直接抛 `SubagentDepthError` |
| 在世子代理数也有上限 | `subagent.maxActiveSubagents` | **结构性**：超过上限时委派直接失败并报 `subagent limit reached`，**不会排队** |
| 根决策、工人执行 | 人设规则 | 提示词级 |

白名单是 **allow 而非 deny**：将来某个插件新增的工具，对子代理默认不可见。

### 一个工人一个工作区

并发问题是用**隔离**解决的，不是用协调。派活之前，根创建 `_agents/<label>/` 并把**绝对路径**写进任务；子代理**只往那里写**，父目录的文件随便读，要改就发申请。完成后它报告产物清单，由根决定复制哪些进自己的工作区——该合并进现有文件的就合并，该保持独立的就独立。`_agents/` 会保留（并应进 `.gitignore`），以便日后继续使用同一个子代理。

**装上配套守卫，这条边界才是真的拒绝。** 人设是规矩，不是围栏——子代理有 shell，它**有能力**写进你的工作区。守卫插件（[dsh-root-planner-guard](https://github.com/XiaoOu2024/dsh-root-planner-guard)）把调用直接拒掉：

```sh
dsh plugin --profile web add dsh-root-planner-guard --registry https://registry.npmjs.org/
```

它拒绝目标落在 `<工作区>/_agents/` 之外的 `write`、`edit`、`ops_replace`；也拒绝 `workdir` 在工作区之外的 shell 调用，以及命令里写着你文件的绝对路径：

```
write: outside your workspace. You may write only inside "...\_agents"; everything else
in the parent's directory is read-only to you. Send your parent a change request instead
of writing "...\report.md" directly.
```

**有一个限制必须知道**：shell 命令能在运行时拼出路径（`$env:X` 拼 `'..'`、脚本内部写、Here-String），参数扫描看不见。要真正关住子代理的 shell，需要给它一个更窄的沙箱写域，而 DSH 给不了——`sandboxPolicy.resolve()` 只接受 `{ session, mode }`，`workspaceRoot` 恒等于不可变、从父会话继承的 `session.header.cwd`。所以父 agent 的核验仍然是兜底：

```sh
# 派活前
touch _agents/.mark-<label>
# 子代理报告后
find . -path ./_agents -prune -o -type f -newer _agents/.mark-<label> -print
```

零输出 = 子代理没碰过自己目录之外的任何东西；有输出就逐个看。**这条命令不需要 git 仓库**——这一点很要紧，因为本预设开发时对着的那个工作区就不是 git 仓库。

### 大任务上你会撞到的两个上限

两个都是 Host 设置、都是结构性的，也都列在这里——因为它们第一次出现时看着像 bug：

- **`subagent limit reached (active child limit: N)`** —— 子代理是**驻留**的，不只是"在跑"：只有它的轮次结束、收件箱清空、它自己的子代理也销毁之后，槽位才归还。所以宽扇出会把槽位一直占着，直到那批活真正做完；而且**超额的那批不会排队**。机器扛得住就把 `maxActiveSubagents`（**设置 → 子智能体**）调大，否则只派一批你能做完的、收完结果再开下一批。作者自己的 profile 因此设为 16。
- **`subagent depth N exceeds maxDepth M`** —— 叶子层发起委派。这是上限在正常工作，不是故障；子代理自己读就是了。

## 工作方式

```
根 agent  ──委派──▶  子代理  ──委派──▶  … 直到 maxDepth
   │                      │
   └── 决策、集成、把关；每一层都拿同一套工具，也受同一条边界
```

有两个机制决定树有多深，方向一致：

- **白名单**给**每一层**、**每一个**子代理同一套工作集（读、写、shell），也扣掉同样几样。授予不随深度衰减，边界也不衰减。
- **深度上限**（`subagent.maxDepth`，由你控制的 Host 设置）决定有几层。`2` 就是根 → 子 → 孙；调大则更深，设成 `1` 则子代理变叶子。

`toolFilter` 是**全局**工具的掩码，而 `subagent` 不是全局工具：因为 `modelSelectionSettings: true`，它被注册进每个被组合 Agent **自身的作用域**，掩码永远写不上它的名字。所以它不在 `child-tools.mjs` 里——**不是**因为子代理没有它。作用域注册**不受限制影响**，而每个子代理都继承本预设，于是每一层都拿到自己的 `subagent`，可以一直往下派到深度上限为止。

本包早期版本确实把 `subagent` 写进了白名单，结果是**每一次子代理创建都失败**，报 `tools.restrict() names unknown global tool "subagent"`——那是白名单在拒绝一个它永远不可能合法包含的名字，不是工具缺失。

- **根 agent**：先立计划（目标、成功判据、约束、任务清单），把值得一次往返的活派出去，自己保留集成、把关与决策——并在每次委派里**点名允许改哪些文件**。
- **子代理**：干活。读、改被点名的文件、跑属于它的命令，然后回报结论与最小证据，外加**确切改了哪些文件**。
- **根决策**改什么、谁改；工人改了任务之外的东西，那是缺陷，不是主动性。

子代理怎么知道自己是子代理？DSH 会在每个子代理的提示词里强制插入一句 `You are a delegated subagent: …`，运行时注入、无法移除，而预设人设**没有** `{{role}}` 这类变量可用。所以人设里写的是一条**判定指令**：读自己的提示词里有没有那句话。这让人设只需要一份，父与子读到的是同一份文本，因此不会出现「父以为子被这么约束、子其实没读到」的漂移。

## 快速开始

推荐从 npm 安装（预构建，免构建授权步骤）：

```sh
dsh plugin --profile web add dsh-root-planner-preset
```

或直接从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:XiaoOu2024/dsh-root-planner-preset
```

装完**必须**再做一步：**设置 → 子智能体 → 深度上限 = `2`**。（这是 Host 的 `subagent` 设置节，**全局生效、不属于** bundle；设成 `0` 会禁掉全部委派，设计就废了。）

然后**开新会话**，在预设选择器里选 **Root Planner**。完整步骤与故障排查见 [INSTALL.md](INSTALL.md)。

> ⚠️ **最容易踩的坑：根会话必须真的选中 Root Planner。** 有人实测时根会话仍是 `standard`，于是根不受本预设约束、而它派出的子代理却是 `root-planner`——权限与规则整棵树错位，最后据此得出一批关于本预设的错误结论。**确认方法**：跑 `node tools/verify-session.mjs <会话目录>`，它会报出根与全部子会话的预设与深度，**根不是 root-planner 就直接判 FAIL**。

## 适合 / 不适合

**适合**：需要跨很多文件调研的长任务、逆向分析、代码审查，以及任何「读得多、改得少」或「改动必须被仔细决策」的工作。

**不适合**：

- 只想快速改一个文件——多一层委派是纯粹的开销；
- 需要子代理**并行写代码**——这是本预设**故意**禁止的，请改用 `standard` 预设；
- 环境缺少 DSH 的工具基础（见 [INSTALL.md](INSTALL.md) 的前置条件）。

## 仓库内容

| 文件 | 说明 |
|---|---|
| `cordis.patch.yml` | 预设声明（**由脚本生成，不要手改**） |
| `persona.txt` | 人设正文，**要改就改这个** |
| `build-patch.mjs` | 从 `persona.txt` 生成 `cordis.patch.yml` |
| `verify-patch.mjs` | 校验补丁结构、工具白名单，并断言人设逐字节一致 |
| `verify-depth-override.mjs` | 校验深度覆盖是否落到合成配置 |
| `lib-yaml.mjs` | 从本地 DSH 安装里解析 YAML，因此本包**零依赖** |
| `docs/DEVELOPMENT.md` | 维护者文档：设计取舍、机制细节、已验证/未验证边界 |

## 已验证 / 未验证

**已验证**：补丁可被 loader 解析；解析出的人设与 `persona.txt` **逐字节相同**；两个委派工具的白名单排除了所有写入入口、且只包含**运行时报告的全局工具**；干净检出后校验通过（`.gitattributes` 已钉死 LF，否则 Windows 克隆会破坏逐字节校验）；深度覆盖已落到合成配置。

**已在真实任务上端到端验证**——那次运行在一个大型逆向工程目录树上产生了 **24 个后代会话**。下面每一条都读自**会话日志自己持久化的工具 schema**，那是注册表的输出，不是模型的回忆：

| 性质 | 证据 |
|---|---|
| 白名单覆盖每一层 | 根被提供 **31** 个工具；深度 1 与深度 2 的 agent 都是 **25** 个。差额正好是白名单排除的那 6 个：`workflow`、`present`、`job_output`、`job_list`、`job_kill`、`exit_plan_mode`。 |
| 子代理确实是工人 | `write`、`edit`、`ops_replace`、`pwsh` 在每一层都在，而且真的被用了：根 10 次 `write` + 60 次 `edit`，某个深度 1 的子代理 14 次 `write`，某个深度 2 的孙代理 20 次 `write`。 |
| 子代理留不下运行中的进程 | `run_in_background` 在三个层级的 `pwsh` schema 里**都不存在**。（朴素的全日志搜索会给出相反答案——`ops_bash` 自己的描述里也有这个词，所以要用 `tools/check-pwsh-background.mjs` 看 schema 窗口。） |
| 递归成立 | 12 个直接子代理，其中 4 个继续派出了 12 个孙代理；根自己做了 14 次 `subagent` 调用。 |
| 深度上限有效 | 树停在深度 2；整个日志目录里不存在任何深度 3 的会话。 |
| 在世上限是软拒绝而非致命 | 8 路扇出时出现一次 `subagent limit reached (active child limit: 8)`；子代理完结时结算通知归还了槽位，此后每次委派都成功。 |

**一处事后更正**：本文件早期版本称"白名单让子代理成为叶子"。**并非如此。** `subagent` 是按每个被组合 Agent 注册、而非全局注册，所以白名单**永远无法写下它的名字**；而限制只过滤全局工具，因此子代理**保有此工具**。递归的边界是 `maxDepth`，不是白名单。

**想自己核**：`tools/verify-session.mjs` 能证明每个会话跑的是哪个预设、深度多少，但它不读工具 schema。逐层工具清单用 `tools/extract-offered-tools.mjs`，进程边界用 `tools/check-pwsh-background.mjs`，实际调用用 `tools/count-tool-calls.mjs`。

## 参与维护

**欢迎提 issue 和 PR——这个仓库本来就打算由作者之外的人一起维护。** 许可证是 [MIT](LICENSE)，fork、修改、再分发都是允许的。**[CONTRIBUTING.md](.github/CONTRIBUTING.md) 写清了流程、校验项和底线要求**，改人设之前请先读它。

按价值排序，有用的贡献大概是这样：

- **报告你遇到的故障**，带上完整报错和你使用的 DSH 版本。上面「未验证」那段正是最需要真实反馈的地方。
- **报告工具白名单在你的环境里不匹配**：你的 profile 注册了哪些全局工具、白名单里哪个名字报错了。
- **改进人设**（`persona.txt`）——但请跑一次 `node build-patch.mjs && node verify-patch.mjs` 并把结果一并附上，因为 `cordis.patch.yml` 是生成文件，手工改过的会被拒。
- **翻译或修订文档**——[README.md](README.md) 与 [INSTALL.md](INSTALL.md)。

请一个 PR 只做一件事，并说明你在哪个预设下验证过。

## 许可

[MIT](LICENSE)
