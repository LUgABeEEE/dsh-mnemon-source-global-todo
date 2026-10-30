# dsh-mnemon-source-global-todo

**把 [`dsh-global-todo`](https://github.com/LUgABeEEE/dsh-global-todo) 里未完成 / 逾期的条目，接进 [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) 的上下文——只读。**

装上它以后，每一轮对话的记忆视图里会多一段「全局待办」，模型不必先调工具就知道你手上还有什么没做完；
另有一条 `search` 路由，可以按关键词查这批条目。它**不写**清单：待办只有一个写入口（那个插件自己的锁），
记忆库只是读者。

## 它提供什么

| | |
|---|---|
| 一个 turn 级投影 | 标题行「全局待办：未完成 N 条，逾期 M 条」+ 最多 `projectLimit` 条（默认 5），按逾期 → 截止 → 优先级 → 新旧排序 |
| 一条 `search` 路由 | 入参 `{ query, limit }`，在这批条目里按标题 / 优先级 / 状态 / 标签子串匹配；同样跳过收件箱 |
| 收件箱**不算**未完成 | `dsh-global-todo` 0.22.0 起，Agent 记的、没有截止时间的条目会先停在「收件箱」等你确认。那些是**待你决定的事**，不是清单上的活，所以投影和 search 都不含它们（依据 `inbox` 标签判断，旧版本写的文件同样处理） |
| 一个 read grant | 投影与搜索共用同一份快照（`exact-snapshot`），revision 对不上就报错，不渲染一份视图没声明过的清单 |

不给写：`manifest.actions` 是空的。**这是设计，不是缺功能**——待办的「完成」要人点头（见 dsh-global-todo 的
确认门），一个记忆源不该能替你勾掉。

## 安装

```sh
# 从 npm 装（0.1.1 起可用）
dsh plugin --profile <profile> add dsh-mnemon-source-global-todo
# 或者直接从 GitHub 装（跟着 main 走）
dsh plugin --profile <profile> add github:LUgABeEEE/dsh-mnemon-source-global-todo
```

1. 装完**重启宿主**；
2. 到 dsh-mnemon 的「记忆系统 / 设置」里把这个 Source 选中（它提供 `source` 能力，角色 `actions`）；
3. 打开任意一个对话，那一轮的上下文里应当出现「全局待办：…」这一行。

**没装 dsh-mnemon 会怎样？** 什么都不发生。本包声明 `inject: ['mnemonMemory']`，没有那个服务时插件根本不会
apply——不报错、不占位、不需要清理。**同时，`dsh-global-todo` 自己不知道这个包存在**：它的引导、工具、面板与
`0.20.0` 之前完全一致（那边有测试专门钉这一点）。

**装了又卸载呢？** 也不会有残留的报错：

| 状态 | 发生什么 |
|---|---|
| 记忆插件在 | 正常投影 + 搜索 |
| 记忆插件被卸载，本包还在 | 入口模块**照常加载**（`lib/index.js` 里没有一行静态 `import 'dsh-mnemon/*'`），`inject` 永远等不到服务 → 永远不 apply。插件列表里它是一个等待中的包，不是一条红色失败 |
| 半卸载（服务还在、包已不可解析） | `apply` 抓到这个错误，写一条 warn，然后什么都不做——不会让对话起不来 |
| 只卸载了 `dsh-global-todo` 本体 | 本包仍能读那份 JSON（它读的是**文件**，不是对方的服务）；文件没了就是空投影 |

重装记忆插件之后不需要动本包：服务一出现，Cordis 自己会调 `apply`。

## 配置

`cordis.patch.yml` 的这行：

```yaml
- id: mnemon-source-global-todo
  name: dsh-mnemon-source-global-todo
  config:
    storePath: ''        # 空 = $DSH_HOME/global-todo/todos.json
    projectLimit: 5     # 0 关掉投影，只留 search 路由
    titleLimit: 80      # 投影里每条标题保留多少字
    searchLimit: 20     # search 一次最多返回几条
```

`storePath` 必须是**正在被 dsh-global-todo 使用的那份文件**；它读的是同一个 JSON，所以面板里一改，下一轮就变。

## 安全与失败

- **只读**：只调用 `readFile` / `stat`，不写、不删、不建目录。
- 文件不存在 / 读不了：当成空清单，`availability: 'unavailable'`——一个还没建过清单的机器不是错误。
- 文件坏（不是 JSON）：当成空清单，revision 上标 `:corrupt`；真正的损坏由 dsh-global-todo 报 `store-corrupt`，
  记忆源不假装懂它。
- 每轮一次读：命中缓存（`mtimeMs:size` 没变）约 `0.05 ms`；真正解析一次约 `13–43 ms`（实测 1.5 MB / 314 条）。
  清单继续长大时，下一步是增量读，而不是把整份 JSON 每轮解析一遍。

## 开发

```sh
npm test           # 9 项：路径、缺失/损坏、排序、投影边界、revision 冲突、搜索、manifest
```

测试不需要装 mnemon 运行时，只从它的公开 `dsh-mnemon/contracts`、`dsh-mnemon/extension-sdk` 取类型与工厂；
`node_modules/dsh-mnemon` 指向你 profile 里那份（`peerDependencies`，不打包）。

## License

MIT © 2026 LUgABeEEE
