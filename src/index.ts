// koishi-plugin-chatlog
// 群消息收集器：把群里所有消息按统一规则入库（实时 + 断线补录）。
//
// 定位：数据层。其它插件（整活 / 词云等）通过 inject: ['chatlog'] 依赖本插件的
// `ctx.chatlog` 服务，用 service 方法读取记录，绝不直接写库 —— 写入只走本插件。
//
// 注意：本插件的收集中间件必须在 koishi.yml 里排在「整活」「纠错」等
// 消费型插件**之前**（Koishi 按加载顺序执行 middleware，非 prepend 的排在后面），
// 这样指令（如 wd）与「你好」不会被收集，与原 dedide 行为一致。
import { Schema, Context, Service, h } from 'koishi'
import { extendChatlogModels, ChatlogMessage, MediaConfig } from './types'
import { ingestMessage } from './ingest'
import { catchupGuild, CatchupOptions, CatchupResult } from './catchup'
import { extractImageUrl } from './normalize'
import { removeImage } from './media'
import { getJieba } from './jieba'

export const name = 'chatlog'
// jieba 是**必需**服务：由 koishi-plugin-jieba 或 koishi-plugin-hanlpjieba 提供，
// 消费方不感知具体实现。provider 未启用时本插件不启动（与 database 一致）。
export const inject = ['database', 'jieba']

export interface Config {
  // ── 收集 ──
  enableCollect?: boolean
  // ── 媒体存储 ──
  maxImageMb?: number
  maxImageStorageMb?: number
  assetsDir?: string
  // ── 断线补录 ──
  enableCatchup?: boolean
  catchupOnReconnect?: boolean
  catchupMaxPerRun?: number
  catchupPageSize?: number
  catchupMaxPages?: number
  // ── 数据保留 ──
  retainMessages?: number
}

export const Config: Schema<Config> = Schema.object({
  enableCollect: Schema.boolean().description('启用实时消息收集（中间件）').default(true),

  maxImageMb: Schema.number().description('单张图片大小上限（MB）').default(20).min(1).max(200),
  maxImageStorageMb: Schema.number().description('图片总存储上限（MB），超出后删最旧的').default(2048).min(10).max(102400),
  assetsDir: Schema.string().description('图片落盘目录（相对数据根）').default('data/assets/chatlog'),

  enableCatchup: Schema.boolean()
    .description('启用断线补录：重连后把掉线期间漏掉的消息按实时规则补进数据库').default(true),
  catchupOnReconnect: Schema.boolean()
    .description('机器人上线（含重连）时自动补录所有群').default(true),
  catchupMaxPerRun: Schema.number()
    .description('单群单次最多补录多少条（防止一次拉爆）').default(2000).min(50).max(20000),
  catchupPageSize: Schema.number()
    .description('每页向协议端拉取多少条历史消息').default(100).min(10).max(500),
  catchupMaxPages: Schema.number()
    .description('单群单次最多翻多少页（防止无限循环）').default(200).min(1).max(2000),

  retainMessages: Schema.number()
    .description('每群保留的最新消息条数上限（超过后清理最旧的；0 = 不清理）')
    .default(0).min(0).max(100000),
})

/**
 * ChatLog 服务：给其它插件一个稳定的读写入口。
 */
export class ChatLog extends Service {
  // jieba 是必需服务（provider 由 koishi.yml 决定：jieba 或 hanlpjieba）。
  static inject = ['database', 'jieba']
  // 控制台插件配置页从 `loader.resolve(name)` 取 schema，而 resolve() 会
  // `unwrapExports()` 成 `module.default`（即本类，**不是**模块命名空间）。
  // 只 export const Config 的话，default 上没有 Config → 配置页显示不出表单。
  // 因此把 Config 也挂到类上（与 koishi-plugin-jieba 的写法一致）。
  static Config = Config
  private mediaOpts: MediaConfig & { assetsDir?: string } = {}

  constructor(ctx: Context, cfg: Config) {
    super(ctx, 'chatlog', true)
    this.config = cfg
  }

  protected async start(): Promise<void> {
    extendChatlogModels(this.ctx)
    this.mediaOpts = {
      maxImageBytes: this.config.maxImageMb ? this.config.maxImageMb * 1024 * 1024 : undefined,
      maxTotalBytes: this.config.maxImageStorageMb ? this.config.maxImageStorageMb * 1024 * 1024 : undefined,
      assetsDir: this.config.assetsDir,
    }
    const jieba = getJieba(this.ctx) as any
    this.ctx.logger('chatlog').info(
      'tokenizer: ctx.jieba (provider: %s)', jieba?.name ?? 'unknown')
    this.setupCollector()
    this.setupCatchup()
    this.setupCommand()
  }

  /** 供 ingest 用的媒体配置（落盘上限等） */
  get mediaConfig(): MediaConfig {
    return this.mediaOpts
  }

  // ─────────────────────────────────────────────────────────
  // 读取 API（供消费型插件使用）
  // ─────────────────────────────────────────────────────────

  /** 取本群全部记录（可按 kind 过滤） */
  async getMessages(guildId: string, kind?: string): Promise<ChatlogMessage[]> {
    const query: any = { guildId }
    if (kind) query.kind = kind
    return await this.ctx.database.get('chatlog_message', query) as ChatlogMessage[]
  }

  /** 随机取一条指定类型的记录 */
  async pickMessage(guildId: string, kind?: string): Promise<ChatlogMessage | null> {
    const rows = await this.getMessages(guildId, kind)
    if (!rows?.length) return null
    return rows[Math.floor(Math.random() * rows.length)]
  }

  /**
   * 取「7 天前、message 长度≥7、jbmsg 至少 2 词」的历史记录（Mock 中间件的候选池）。
   * 返回后由调用方按 token 在内存中筛选（与原 dedide 语义一致）。
   */
  async findSimilar(guildId: string): Promise<ChatlogMessage[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    return await this.ctx.database.get('chatlog_message', {
      guildId,
      message: { $regex: new RegExp('^.{7,}$') },
      jbmsg: { $regex: /,/ },
      message_time: { $lt: sevenDaysAgo },
    } as any) as ChatlogMessage[]
  }

  /** 取词表（问……什么 玩法用） */
  async getVocab(): Promise<{ words: string }[]> {
    return await this.ctx.database.get('chatlog_vocab', {}) as any[]
  }

  /** 删除一条记录（Mock 回放后消耗掉该条） */
  async removeMessage(message: string): Promise<void> {
    await this.ctx.database.remove('chatlog_message', [message])
  }

  /** 删除已回放的图片文件 */
  async removeMedia(file: string): Promise<void> {
    await removeImage(file)
  }

  /** 刷新一条记录的时间到现在（mock 命令抽中后 7 天内不再被抽中，但条数不减） */
  async touchMessage(message: string): Promise<void> {
    const rows = await this.ctx.database.get('chatlog_message', { message } as any) as ChatlogMessage[]
    const row = rows[0]
    if (!row) return
    await this.ctx.database.upsert('chatlog_message', [{
      message: row.message,
      guildId: row.guildId,
      jbmsg: row.jbmsg,
      message_time: new Date(),
      nickname: row.nickname ?? null,
      kind: row.kind ?? 'text',
      media: row.media ?? '',
    }])
  }

  /** 词表修剪：只保留最新 keep 条（问……什么 玩法调用） */
  async trimVocab(keep = 1919): Promise<void> {
    const rows = await this.ctx.database.get('chatlog_vocab', {}) as any[]
    for (let i = 0; i < rows.length - keep; i++) {
      await this.ctx.database.remove('chatlog_vocab', [rows[i].words])
    }
  }

  /**
   * 把一条消息按实时规则写入数据库（供本插件中间件 / 补录使用）。
   * 消费型插件不要调用 —— 写入只属于收集器。
   */
  async ingest(content: string, guildId: string, nickname: string | null | undefined, when?: Date): Promise<boolean> {
    return ingestMessage(content, this.ctx, guildId, nickname, when ?? new Date(), this.mediaOpts)
  }

  /** 执行一次某群的断线补录 */
  async catchup(bot: any, guildId: string, logger?: (msg: string) => void): Promise<CatchupResult> {
    return catchupGuild(this.ctx, bot, guildId, {
      ...this.catchupOpts(),
      logger,
    })
  }

  private catchupOpts(): CatchupOptions {
    return {
      maxPerRun: this.config.catchupMaxPerRun ?? 2000,
      pageSize: this.config.catchupPageSize ?? 100,
      maxPages: this.config.catchupMaxPages ?? 200,
      maxImageBytes: this.mediaOpts.maxImageBytes,
      maxTotalBytes: this.mediaOpts.maxTotalBytes,
      assetsDir: this.mediaOpts.assetsDir,
    }
  }

  // ─────────────────────────────────────────────────────────
  // 内部：实时收集 + 补录触发 + 命令
  // ─────────────────────────────────────────────────────────

  private setupCollector() {
    if (this.config.enableCollect === false) return
    // 注意：不要 prepend。 Koishi 按注册顺序执行非 prepend 的 middleware，
    // koishi.yml 里本插件排在消费型插件之前 → 指令先被处理，剩下的才被收集。
    this.ctx.middleware(async (session, next) => {
      const c = session.content || ''
      if (!session.guildId || !c) return next()
      // 指令消息（以本 bot 前缀开头的）不收集：next() 之后已是剩余文本，
      // 简单起见交给消费方 —— 指令通常已在前面被 command 短路。
      try {
        await ingestMessage(c, this.ctx, session.guildId, session.author?.name ?? null, new Date(), this.mediaOpts)
      } catch (e: any) {
        this.ctx.logger('chatlog').warn('实时入库失败:', e?.message || e)
      }
      // 清理超量（低频触发：每 500 条做一次按时间的分界检查成本可控，这里简化为按概率）
      if (this.config.retainMessages && Math.random() < 0.02) {
        this.cleanOld(session.guildId, this.config.retainMessages).catch(() => { })
      }
      return next()
    })
  }

  /** 每群保留最新 retainMessages 条，超出删旧（原 cleanMockDB 逻辑，默认关闭） */
  private async cleanOld(guildId: string, retainCount: number) {
    if (!retainCount) return
    try {
      const cutoff = await this.ctx.database
        .select('chatlog_message')
        .where({ guildId })
        .orderBy('message_time', 'desc')
        .offset(retainCount)
        .limit(1)
        .execute()
      if (!cutoff.length) return
      await this.ctx.database.remove('chatlog_message', {
        guildId,
        message_time: { $lte: cutoff[0].message_time },
      })
    } catch { }
  }

  private setupCatchup() {
    if (this.config.enableCatchup === false) return
    const logger = this.ctx.logger('chatlog')

    /**
     * 等待 bot 的 OneBot 通道真正可用。
     * 坑：`adapter-onebot` 的 ws-reverse 是先 `online()` 再（在 socket 的
     * `addEventListener('open')` 回调里）挂上 `bot.internal._request`，
     * 所以 `ready` 触发时 `_request` 可能还不存在。
     */
    async function waitForBotReady(bot: any, timeoutMs = 30000): Promise<boolean> {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        try {
          if (typeof bot?.internal?._request === 'function') return true
        } catch { }
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    }

    const runCatchupForBot = async (bot: any, trigger: string): Promise<boolean> => {
      if (!(await waitForBotReady(bot))) {
        logger.warn('等待 OneBot 通道可用超时，补录跳过（bot 上线后会重试）')
        return false
      }
      let guilds: string[] = []
      try {
        const res = await bot.getGuildList()
        guilds = (res?.data ?? []).map((g: any) => String(g.id)).filter(Boolean)
      } catch (e: any) {
        logger.warn('获取群列表失败，补录跳过:', e?.message || e)
        return false
      }
      if (!guilds.length) {
        logger.info('没有群，补录跳过')
        return false
      }
      let total = 0
      for (const gid of guilds) {
        try {
          const r = await catchupGuild(this.ctx, bot, gid, {
            ...this.catchupOpts(),
            logger: (m) => logger.info(m),
          })
          total += r.stored
        } catch (e: any) {
          logger.warn(`补录 ${gid} 失败:`, e?.message || e)
        }
      }
      logger.info(`[${trigger}] 补录结束，共入库 ${total} 条`)
      return true
    }

    if (this.config.catchupOnReconnect !== false) {
      /**
       * 每台 bot 首次**成功**补录后不再重复。
       * 坑：koishi 先起、QQ 后登录（无头环境卡在登录页）时，启动期的
       * `waitForBotReady` 会超时；此时若把 sid 记为"已处理"，等 bot 真正
       * ONLINE 就不会再补录（2026-11-17 事故）。因此只有成功才落 `done`，
       * 超时/失败留给下一次 `bot-status-updated` 重试。
       */
      const done = new Set<string>()
      const inflight = new Set<string>()
      const trigger = (bot: any) => {
        if (!bot?.sid || done.has(bot.sid) || inflight.has(bot.sid)) return
        inflight.add(bot.sid)
        runCatchupForBot(bot, 'reconnect')
          .then((ok) => { if (ok) done.add(bot.sid) })
          .catch((e) => logger.warn('补录异常:', e?.message || e))
          .finally(() => inflight.delete(bot.sid))
      }

      this.ctx.on('bot-status-updated', (bot: any) => {
        // Status.ONLINE = 1
        if (bot?.status === 1) trigger(bot)
      })

      this.ctx.on('ready', () => {
        for (const bot of Object.values(this.ctx.bots) as any[]) trigger(bot)
      })
    }

    // 手动补录：只能由管理员/自己触发
    this.ctx.command('catchup', '把掉线期间漏掉的消息补进数据库')
      .alias('补录')
      .option('all', '-a 补录本 bot 的所有群（默认只补当前群）')
      .usage('catchup [-a]\n重连后会自动执行；此命令用于手动立即补录')
      .action(async ({ session, options }) => {
        if (!session?.bot) return '没有可用的 bot'
        if (options?.all) {
          await runCatchupForBot(session.bot, 'manual-all')
          return '已触发全群补录，结果见日志'
        }
        if (!session.guildId) return '只能在群里用，或加 -a 补录全部群'
        if (!(await waitForBotReady(session.bot, 5000))) return '协议端通道还没就绪，请稍后再试'
        const r: CatchupResult = await catchupGuild(this.ctx, session.bot, session.guildId, {
          ...this.catchupOpts(),
          logger: (m) => logger.info(m),
        })
        return `补录完成：拉取 ${r.fetched} 条，入库 ${r.stored} 条，跳过 ${r.skipped} 条`
          + (r.truncated ? '（触到单次上限，下次继续）' : '')
      })
  }

  private setupCommand() {
    // 数据查看命令：看收集器有没有在工作
    this.ctx.command('chatlog.status', '查看消息收集状态')
      .alias('收集状态')
      .action(async ({ session }) => {
        if (!session?.guildId) return '只能在群里用哦'
        try {
          const rows = await this.ctx.database.get('chatlog_message', { guildId: session.guildId } as any)
          const marks = await this.ctx.database.get('chatlog_watermark', { guildId: session.guildId } as any)
          const text = rows.filter(r => r.kind === 'text').length
          const img = rows.filter(r => r.kind === 'image').length
          const url = rows.filter(r => r.kind === 'url').length
          const mark = marks[0]
          return `本群已收集：文本 ${text} / 图片 ${img} / 链接 ${url}`
            + (mark?.lastTime ? `，水位 ${new Date(mark.lastTime).toLocaleString('zh-CN')}` : '，水位未建立')
        } catch {
          return '查询失败'
        }
      })
  }
}

// 供消费插件使用的类型（纯函数从子模块引入）
export { ingestMessage, catchupGuild, elementsToContent, extractImageUrl, extractUrl, normalizeContent, isMediaOnly, isFaceOnly, isImageUrl, saveImage, removeImage, getJieba } from './exports'
export type { CatchupOptions, CatchupResult, Awaitable, JiebaService, Segment } from './exports'
export type { MediaConfig, ChatlogMessage, ChatlogVocab, ChatlogWatermark } from './types'
export { restoreFaces } from './faces'

// Service 类插件：默认导出类本身（loader 会 new ChatLog(ctx, config)）
export default ChatLog

