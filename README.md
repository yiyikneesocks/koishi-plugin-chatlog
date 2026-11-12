# koishi-plugin-chatlog

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatlog?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatlog)

群消息收集器 for Koishi：把群里所有消息按统一规则入库（文本 / 图片 / 链接），支持 jieba 分词与断线补录（catchup）。

**定位：数据层插件。** 其它插件（如 [koishi-plugin-group-gags](https://www.npmjs.com/package/koishi-plugin-group-gags)、
[koishi-plugin-wordcloud](https://www.npmjs.com/package/koishi-plugin-wordcloud)）通过 `inject: ['chatlog']`
依赖本插件提供的 `ctx.chatlog` 服务读取记录。

## 安装

```bash
npm install koishi-plugin-chatlog
```

需要数据库插件（sqlite / mysql）与 `koishi-plugin-jieba`（分词）。

## 功能

- **实时收集**：非 prepend 中间件，指令先被处理、剩下的消息才被收集
  （与旧 dedide 行为一致：`wd` 等指令与「你好」不会被收集）
- **文本**：4~50 字且至少 1 个分词 → `kind='text'`（含 `jbmsg` 分词结果），并更新词汇表
- **图片**：下载落盘（默认 `data/assets/chatlog/`，单图/总量上限可配）→ `kind='image'`
- **链接**：纯链接 → `kind='url'`（QQ 媒体 CDN 链接自动识别为图片资源，不会混进链接池）
- **表情 only / 分享卡片**：丢弃
- **断线补录（catchup）**：机器人重连后按水位把漏掉的消息按实时规则补进数据库；
  首次运行只建水位不补历史；`catchup` 命令可手动补录（`-a` 补全部群）
- **`chatlog.status` 命令**：查看本群收集状态与水位

## 数据表

| 表 | 内容 |
|---|---|
| `chatlog_message` | 消息记录（原 dedide 的 `mock` 表，本插件启动时自动 `RENAME` 不做——请手动迁移，见下） |
| `chatlog_vocab` | 词汇表（原 `what` 表） |
| `chatlog_watermark` | 每群补录水位（原 `mock_catchup` 表） |

从旧版 dedide 迁移：

```sql
RENAME TABLE mock TO chatlog_message;
RENAME TABLE what TO chatlog_vocab;
RENAME TABLE mock_catchup TO chatlog_watermark;
```

## 给插件开发者的服务 API

```ts
ctx.chatlog.getMessages(guildId, kind?)     // 读取记录
ctx.chatlog.pickMessage(guildId, kind?)     // 随机取一条
ctx.chatlog.findSimilar(guildId)            // Mock 候选池（7 天前、长度≥7、词数≥2）
ctx.chatlog.getVocab()                      // 词表
ctx.chatlog.removeMessage(msg)              // 回放后消耗一条
ctx.chatlog.touchMessage(msg)               // 刷新时间戳（7 天内不再被抽中）
ctx.chatlog.trimVocab(keep)                 // 词表修剪
ctx.chatlog.mediaConfig                     // 媒体落盘配置（消费方读）
```

纯函数（`normalizeContent` / `extractImageUrl` / `restoreFaces` 等）也从包根导出。

## 配置项

见插件页 Config 面板；默认全部可用（收集开、补录开、重连自动补录）。
