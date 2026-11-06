# dsh-rooms · 跨会话协作

把活派给另一个会话（**房间**），干完回报，在侧栏面板里看分组。

DeepSeek Harness 一个会话只能专注一件事。dsh-rooms 让会话之间互相派活：**工作区里每个会话都是一间房**，不用的会话就是没分组的房间。派活是「发送」，回报是「回报」，两种消息走的路不一样。侧栏面板只负责分组：拖一下卡片，房间就归到某个组。

## 两种消息

| 类型 | 工具 | 能发给谁 |
|---|---|---|
| **发送** | `room_send` | 同一分组里的任何房间 |
| **回报** | `room_report` | 只回给给它派活的那个会话 |

回报不会广播：谁派的活，回报就回给谁。派活的会话已经不在了，回报只留在状态里，不会硬塞给别的会话。

## 谁能派活

**同一个分组**里的房间才能互派。没有特殊身份，也没有「加入」这一步——所有会话本来就是房间。

「未分组」不是一组，它只是「当前还没归组」的意思：目标没分组、或者自己没分组，都派不了，先把它们拖进同一个组。归档的会话不算房间，面板不显示，派活也会被拒。

## 安装

```bash
dsh plugin install /path/to/dsh-rooms
```

装完重启 Harness，侧栏出现「房间」图标。

## 配置

配置写在 bundle 的 patch（`cordis.patch.yml`）里，也能在自己的 profile 覆盖。配置里的房间只是「预置一间房」——给它起个占位名、指定目录和岗位说明，第一次派活时才会真的建会话。工作区里其它会话不用写配置，打开面板就在。

### 全局

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `idleTimeoutMinutes` | number | `15` | 派出去这么多分钟没回报、会话也没在写盘，就向派活方发一条提醒；`0` = 不提醒。面板可改 |
| `reportHint` | string | 「干完用 room_report 工具回报…」 | 派活时自动追加在任务后面那句话 |
| `defaultCwd` | string | 进程当前目录 | 房间没写 `cwd` 时用它 |
| `stateDir` | string | `~/.dsh-rooms` | 状态文件放哪（会话映射、回报、分组） |
| `apiPrefix` | string | `/dsh-rooms/api` | 面板读数据用的接口前缀 |

### 房间级

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | 必填 | 房间 id，派活时用它 |
| `sessionId` | string | 空 | 绑定已有会话；不填就第一次派活时新建 |
| `title` | string | 同 `id` | **占位名**：会话还没有标题时显示它。面板显示的是工作区里的会话标题 |
| `description` | string | 空 | 这间房管什么 |
| `cwd` | string | `defaultCwd` | 工作目录 |
| `prompt` | string | 空 | 第一次建会话时先发的一段岗位说明 |
| `idleTimeoutMinutes` | number | 跟全局 | 这间房单独的提醒分钟数 |

房间名不在这里定：面板每次打开都重新读会话标题，工作区里改了名，面板跟着变。

### 例子

```yaml
- insert:
    - id: rooms
      name: dsh-rooms
      config:
        idleTimeoutMinutes: 15
        rooms:
          - id: writer
            title: 写作间
            description: 写文章、改稿子。
            cwd: 'D:\work'
            prompt: '你负责写稿。每次交稿都要说清改了哪里。'
          - id: lab
            title: 试验间
          - id: main              # 主会话也配一间，派活时好认
            title: 主控台
            sessionId: 'session-your-main-session-id'
```

## 工具

| 工具 | 作用 |
|---|---|
| `room_list` | 房间、会话 id、目录、分组、最近回报 |
| `room_send` | 派活给同组房间，立刻返回 |
| `room_here` | 查自己这间房的 id，顺便归组 |
| `room_report` | 房间回报 done / blocked / progress |
| `room_cancel` | 叫停这一轮，不删会话 |
| `room_reset` | 重开会话（上下文爆了、跑歪了时用） |

不允许的组合会直接拒掉并说明原因：跨组、没分组、归档。

## 面板

侧栏「房间」图标下两页。

**分组**：打开就扫工作区，正常显示的会话全都是房间（归档的、子会话不摆）。卡片上只有名字和「干活中」两样；点一下不动作，拖进某个组就归组，拖到最下面的「未分组」就取消归组。「未分组」只是收容没归组的房间，它本身不是一组。干活中的卡片锁住不能拖。新建分组、改名、删除都在这一页。面板不派活，也没有详情页。

**配置**：多久没动静就提醒。

## 数据

`stateDir/state.json`：会话映射、回报记录、分组、每间房上次的派活方。删掉它等于重置（会话 id 也会丢，慎删）。

## 接口

面板通过 `apiPrefix` 下的 POST 接口读数据，同一个 Web 服务，不额外开端口：

`list` · `createGroup` · `renameGroup` · `deleteGroup` · `moveRoom` · `setConfig`

## 许可

MIT
