// 消息入库：把一条消息按统一规则写进 chatlog_message / chatlog_vocab。
// 实时收集与断线补录共用同一个入口，保证补进来的数据与实时收到的一模一样。
import { Context } from 'koishi'
import type { MediaConfig } from './types'
import { normalizeContent, isMediaOnly, isFaceOnly, extractImageUrl, extractUrl } from './normalize'
import { saveImage } from './media'
import { getJieba } from './jieba'

/**
 * 把一条消息按「正常实时接收时完全相同的规则」写入数据库：
 *   - 图片 → 下载落盘后存 kind='image'（失败/超限则丢弃）
 *   - 纯链接 → 存 kind='url'
 *   - 卡片/其它媒体 → 丢弃
 *   - 只有表情 → 丢弃
 *   - 文本且 4..50 字、至少 1 个候选词 → 存 kind='text'（并更新 chatlog_vocab 词表）
 *
 * @param when 消息的真实发生时间（补录时必须用历史时间，而不是 now）
 * @returns 是否写入了数据库
 */
export async function ingestMessage(
  content: string,
  ctx: Context,
  guildId: string,
  nickname: string | null | undefined,
  when: Date,
  mediaOpts: MediaConfig = {},
): Promise<boolean> {
  if (!content) return false

  // ── 图片：落盘后存 image ──
  const imageUrl = extractImageUrl(content)
  if (imageUrl) {
    // 补录去重：同群 + 同时间已有图片记录 → 视为已补过，跳过（避免重复下载）
    try {
      const existing = await ctx.database.get('chatlog_message', {
        guildId,
        kind: 'image',
        message_time: when,
      } as any)
      if (existing?.length) return false
    } catch { }

    const saved = await saveImage(ctx, imageUrl, mediaOpts)
    if (!saved) return false
    try {
      await ctx.database.upsert('chatlog_message', [{
        message: `[image]${saved}`,
        guildId,
        jbmsg: [],
        message_time: when,
        nickname: nickname || null,
        kind: 'image',
        media: saved,
      }] as any)
      return true
    } catch (e) {
      console.error('补录图片失败：', e)
      return false
    }
  }

  // ── 纯链接：存 url ──
  const url = extractUrl(content)
  if (url) {
    try {
      await ctx.database.upsert('chatlog_message', [{
        message: url,
        guildId,
        jbmsg: [],
        message_time: when,
        nickname: nickname || null,
        kind: 'url',
        media: url,
      }] as any)
      return true
    } catch (e) {
      console.error('补录链接失败：', e)
      return false
    }
  }

  if (isMediaOnly(content)) return false
  if (isFaceOnly(content)) return false

  const plain = normalizeContent(content)
  const EMOJI_RE = /\p{Extended_Pictographic}/u
  // 分词统一走 jieba 服务；await 同时兼容同步（koishi-plugin-jieba）与异步 provider。
  const jbFltList = (await getJieba(ctx).cut(plain))
    .filter((word) => word.trim().length > 0)
    .filter((word) => [...word].length >= 2 || EMOJI_RE.test(word))

  let wrote = false
  if (4 <= plain.length && plain.length <= 50 && jbFltList.length >= 1 && !isMediaOnly(plain)) {
    try {
      await ctx.database.upsert('chatlog_message', [{
        message: plain,
        guildId,
        jbmsg: jbFltList,
        message_time: when,
        nickname: nickname || null,
        kind: 'text',
        media: '',
      }] as any)
      for (const w of jbFltList) {
        await ctx.database.upsert('chatlog_vocab', [{ words: w }])
      }
      wrote = true
    } catch (e) {
      console.error('补录文本失败：', e)
    }
  }

  if (2 <= plain.length && plain.length <= 5) {
    try {
      await ctx.database.upsert('chatlog_vocab', [{ words: plain }])
    } catch (e) {
      console.error('补录词表失败：', e)
    }
  }

  return wrote
}
