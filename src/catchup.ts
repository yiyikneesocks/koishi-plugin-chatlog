// 断线补录：从协议端（NapCat）拉取历史消息，按实时规则补进数据库。
// 从原 dedide catchup.ts 原样迁移，仅表名改为 chatlog_*。
import { Context } from 'koishi'
import type { ChatlogWatermark, MediaConfig } from './types'
import { ingestMessage } from './ingest'

export interface CatchupOptions extends MediaConfig {
  /** 单群单次最多补录多少条消息（防止一次拉爆） */
  maxPerRun?: number
  /** 每页向 NapCat 拉取多少条 */
  pageSize?: number
  /** 最多往前翻多少页（防止无限循环） */
  maxPages?: number
  /** 是否打印进度日志 */
  logger?: (msg: string) => void
}

export interface CatchupResult {
  guildId: string
  fetched: number
  stored: number
  skipped: number
  pages: number
  /** 本次补录是否因为触到上限而中途停止（下次可继续） */
  truncated: boolean
}

/**
 * 拉取一页历史消息（旧→新 或 新→旧 由协议端决定，调用方不能假设顺序）。
 *
 * 关键坑（2026-11-08 实测）：
 *   adapter-onebot 的 `bot.getMessageList(channelId, before)` 内部先 `getMsg(before)`
 *   再取 `message_seq`。当 `before` 是 NapCat 的 message_id 时，`getMsg` 常常只返回
 *   那一条、拿不到可用 seq → 翻页原地打转。
 *   这里直接调 `bot.internal.getGroupMsgHistory(groupId, message_seq)`，
 *   以「本页最早那条的 message_id」作为 seq（NapCat 的 short id 即 message_id），
 *   绕开 adapter 的 getMsg 中转。
 *
 * 返回的每条消息都带 `_raw`（原始 OneBot 结构）与标准化字段
 * （id / timestamp / user / elements），供 `elementsToContent` 使用。
 */
async function fetchPage(
  ctx: Context,
  bot: any,
  guildId: string,
  cursor: string | undefined,
  pageSize: number,
): Promise<any[]> {
  const internal = bot?.internal

  if (typeof internal?.getGroupMsgHistory === 'function') {
    // 用 internal._request 直调，才能传 count / reverse_order（adapter 的
    // getGroupMsgHistory 包装只转发 group_id + message_seq，无法指定 count）。
    const req = internal._request
    let res: any
    if (typeof req === 'function') {
      const params: any = { group_id: String(guildId), count: pageSize, reverse_order: true }
      if (cursor) params.message_seq = cursor
      res = await req.call(internal, 'get_group_msg_history', params)
      res = res?.data ?? res
    } else {
      res = cursor
        ? await internal.getGroupMsgHistory(Number(guildId), cursor, pageSize)
        : await internal.getGroupMsgHistory(Number(guildId), undefined, pageSize)
    }
    const msgs = res?.messages ?? res?.data?.messages ?? []
    return msgs.map((raw: any) => {
      const elements = raw?.message ?? raw?.content ?? []
      return {
        id: String(raw?.message_id ?? raw?.id ?? ''),
        timestamp: (Number(raw?.time ?? raw?.timestamp ?? 0) || Math.floor(Date.now() / 1000)) * (raw?.time ? 1000 : 1),
        user: raw?.sender ? { name: raw.sender.card || raw.sender.nickname || '' } : undefined,
        elements: Array.isArray(elements) ? elements : [elements],
        _raw: raw,
      }
    })
  }

  // 退化：用 adapter 公开 API（可能翻页受限，但至少能拿第一页）
  const res = await bot.getMessageList(guildId, cursor)
  return res?.data ?? []
}

/**
 * 把 OneBot 返回的历史消息还原成「与实时接收一致的 content 字符串」。
 *
 * 实时路径里 `session.content` 是 `elements.join('')` 的 satori 序列化形式，
 * 例如 `<at id="123" name="小明"/>文字<face id="13"/>`。
 * `getMessageList()` 已经返回了 `elements`，直接 `join('')` 即可得到同构字符串，
 * 这样 normalize.ts 里的正则全部原样命中，无需第二套解析逻辑。
 */
export function elementsToContent(message: any): string {
  try {
    const els = message?.elements
    if (Array.isArray(els) && els.length) {
      if (typeof els[0] === 'string') return els.join('')
      return els.map((seg: any) => {
        if (typeof seg === 'string') return seg
        const type = seg?.type
        const d = seg?.data ?? {}
        switch (type) {
          case 'text': return String(d.text ?? '')
          case 'at': return `<at id="${d.qq ?? d.id ?? ''}" name="${d.name ?? ''}"/>`
          case 'image': return `<img src="${d.url ?? d.file ?? ''}"/>`
          case 'face': return `<face id="${d.id ?? ''}"/>`
          case 'mface': return `<face id="${d.id ?? ''}"/>`
          case 'reply': return ''
          default: return ''
        }
      }).join('')
    }
    if (typeof message?.content === 'string') return message.content
    if (Array.isArray(message?.content)) return message.content.join('')
  } catch { }
  return ''
}

/**
 * 对一个群执行「断线补录」：
 *   1. 读取水位（lastMessageId / lastTime）
 *   2. 从最新消息开始往回翻页，直到翻过水位（或触到 maxPages / maxPerRun）
 *   3. 把水位之后的每条消息按实时规则 ingest 入库（历史时间）
 *   4. 更新水位到本次见到的最新消息
 *
 * 首次运行（无水位）只记录水位、不补历史（避免把整个群的陈年旧账全拉进来）。
 * 之后每次运行补的就是「上次水位 → 现在」之间的消息。
 */
export async function catchupGuild(
  ctx: Context,
  bot: any,
  guildId: string,
  opts: CatchupOptions = {},
  segment?: (text: string) => Promise<string[]>,
): Promise<CatchupResult> {
  const log = opts.logger ?? (() => { })
  const maxPerRun = opts.maxPerRun ?? 2000
  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 200

  const result: CatchupResult = {
    guildId, fetched: 0, stored: 0, skipped: 0, pages: 0, truncated: false,
  }

  const rows = await ctx.database.get('chatlog_watermark', { guildId }) as ChatlogWatermark[]
  const mark = rows[0]
  const watermarkId = mark?.lastMessageId ?? ''
  const watermarkTime = mark?.lastTime ? new Date(mark.lastTime).getTime() : 0

  let cursor: string | undefined
  let newestId = ''
  let newestTime = 0
  // 全量收集（不区分顺序），后面统一按时间排序
  const collected: any[] = []
  const seenIds = new Set<string>()
  let reachedWatermark = false
  let pageOldestTime = 0   // 本次「见过的最旧消息时间」

  while (result.pages < maxPages) {
    let page: any[]
    try {
      page = await fetchPage(ctx, bot, guildId, cursor, pageSize)
    } catch (e: any) {
      log(`拉取历史失败（${guildId}）：${e?.message || e}`)
      break
    }
    result.pages++
    if (!page?.length) break
    result.fetched += page.length

    // 本页内最旧消息的时间（不依赖返回顺序），用于「是否翻回了水位」判定
    let pageMin = Infinity
    for (const msg of page) {
      const ts = Number(msg?.timestamp ?? 0)
      if (ts && ts < pageMin) pageMin = ts
    }
    if (Number.isFinite(pageMin)) {
      pageOldestTime = pageOldestTime ? Math.min(pageOldestTime, pageMin) : pageMin
    }

    for (const msg of page) {
      const id = String(msg?.id ?? msg?.messageId ?? '')
      const ts = Number(msg?.timestamp ?? 0)
      if (id && ts >= newestTime) { newestId = id; newestTime = ts }

      if (seenIds.has(id)) continue
      seenIds.add(id)

      // 已到水位边界（时间早于或等于水位）→ 该条及更早都不需要
      if (watermarkTime && ts && ts <= watermarkTime) { reachedWatermark = true; continue }

      collected.push(msg)
      if (collected.length >= maxPerRun) { result.truncated = true; break }
    }

    if (reachedWatermark || result.truncated) break

    // 需要继续往更早翻：用本页「最旧一条」作游标。
    // 若协议端不认该游标（返回空/同一批），游标不前进 → 停止（靠 truncated 语义下次继续）。
    const oldestMsg = page.reduce((a: any, b: any) =>
      (Number(b?.timestamp ?? 0) < Number(a?.timestamp ?? 0) ? b : a), page[0])
    const nextCursor = String(oldestMsg?.id ?? oldestMsg?.messageId ?? '')
    if (!nextCursor || nextCursor === cursor) {
      log(`游标未前进（${guildId}），本页已是最早可获取，停止翻页`)
      break
    }
    cursor = nextCursor
  }

  // 翻页没能翻到水位（历史拿不全）→ 视为 truncated（下次继续往前补）
  if (!reachedWatermark && !result.truncated && watermarkTime && pageOldestTime && pageOldestTime > watermarkTime) {
    result.truncated = true
  }

  // 首次运行（完全没有水位）：只落水位，不补历史
  // 注意判定要用「id 和 time 都没」——只要存过任意一种水位就算「非首次」，
  // 否则 id 为空但 time 有效时会被误判为首次，从而悄悄跳过本应补的历史。
  if (!watermarkId && !watermarkTime) {
    log(`首次建立补录水位（${guildId}）：不补历史`)
    await ctx.database.upsert('chatlog_watermark', [{
      guildId,
      lastMessageId: newestId,
      lastTime: new Date(newestTime || Date.now()),
      updatedAt: new Date(),
    }] as any)
    return result
  }

  // 按时间正序补录（collected 顺序不保证，直接按时间戳升序）
  const ordered = collected.slice().sort(
    (a, b) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0),
  )
  let storedOldestId = ''
  let storedOldestTime = 0
  for (const msg of ordered) {
    const id = String(msg?.id ?? msg?.messageId ?? '')
    const ts = Number(msg?.timestamp ?? 0)
    const content = elementsToContent(msg)
    if (!content) { result.skipped++; continue }
    const nickname = msg?.user?.name ?? msg?.member?.name ?? null
    const when = msg?.timestamp ? new Date(Number(msg.timestamp)) : new Date()
    try {
      const wrote = await ingestMessage(content, ctx, guildId, nickname, when, opts, segment)
      if (wrote) result.stored++
      else result.skipped++
      // 记录「实际处理过的最旧一条」——截断时的水位只能推进到这里
      if (!storedOldestId && id) { storedOldestId = id; storedOldestTime = ts }
    } catch (e: any) {
      result.skipped++
      log(`补录单条失败：${e?.message || e}`)
    }
  }

  // ── 水位推进 ──
  // 完整补完（翻到旧水位）→ 推进到「本次最新」；
  // 中途截断（触到 maxPerRun / maxPages）→ 只能推进到「本次实际处理的最旧一条」，
  // 否则中间那段没拉到的消息会被水位跳过、永久丢失。
  let nextId: string
  let nextTime: number
  if (result.truncated) {
    nextId = storedOldestId || watermarkId
    nextTime = storedOldestTime || watermarkTime
  } else {
    nextId = newestId || watermarkId
    nextTime = newestTime || watermarkTime
  }

  if (nextId && (!mark || nextTime >= watermarkTime)) {
    await ctx.database.upsert('chatlog_watermark', [{
      guildId,
      lastMessageId: nextId,
      lastTime: new Date(nextTime || Date.now()),
      updatedAt: new Date(),
    }] as any)
  }

  log(`补录完成（${guildId}）：拉取 ${result.fetched}，入库 ${result.stored}，跳过 ${result.skipped}，页数 ${result.pages}`)
  return result
}
