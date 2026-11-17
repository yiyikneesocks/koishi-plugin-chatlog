import { Context } from 'koishi'
import { } from '@koishijs/plugin-database-mysql'
import type { ChatLog } from './index'

declare module 'koishi' {
  interface Tables {
    chatlog_message: ChatlogMessage
    chatlog_vocab: ChatlogVocab
    chatlog_watermark: ChatlogWatermark
  }
  interface Context {
    chatlog: ChatLog
  }
}

/** 群消息记录（原 mock 表） */
export interface ChatlogMessage {
  message: string
  guildId: string
  jbmsg: Array<string>
  message_time: Date
  nickname: string | null
  kind: string        // 'text' | 'image' | 'url'
  media: string       // 落盘后的本地路径 / URL（text 时为空）
}

/** 词汇表（原 what 表），供「问……什么」玩法使用 */
export interface ChatlogVocab {
  words: string
}

/** 每个群的补录水位（原 mock_catchup 表） */
export interface ChatlogWatermark {
  guildId: string
  /** 已补录的最后一条消息的 message_id（用作翻页游标 + 去重） */
  lastMessageId: string
  /** 已补录的最后一条消息的真实时间 */
  lastTime: Date
  /** 上次补录完成的时间 */
  updatedAt: Date
}

export interface MediaConfig {
  maxImageBytes?: number      // 单图上限，默认 20MB
  maxTotalBytes?: number      // 图片总占用上限，默认 2GB
  assetsDir?: string          // 图片落盘目录（相对项目根），默认 data/assets/chatlog
}

/** 声明全部三张表（chatlog 服务启动时调用一次） */
export function extendChatlogModels(ctx: Context) {
  ctx.model.extend('chatlog_message', {
    message: 'string',
    guildId: 'string',
    jbmsg: 'json',
    message_time: 'timestamp',
    nickname: 'string',
    kind: 'string',
    media: 'string',
  }, { primary: 'message' })
  ctx.model.extend('chatlog_vocab', { words: 'string' }, { primary: 'words' })
  ctx.model.extend('chatlog_watermark', {
    guildId: 'string',
    lastMessageId: 'string',
    lastTime: 'timestamp',
    updatedAt: 'timestamp',
  }, { primary: 'guildId' })
}
