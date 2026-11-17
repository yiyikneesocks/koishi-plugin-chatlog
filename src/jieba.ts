// jieba.ts
// 本插件对 `ctx.jieba` 的**最小服务契约**。
//
// jieba 是一个 Koishi 服务（与 database 同模式）：服务名固定为 `jieba`，
// 由外部 provider 插件提供，消费方只声明 `inject: ['jieba']`：
//   - koishi-plugin-jieba       （@node-rs/jieba，同步：cut() → string[]）
//   - koishi-plugin-hanlpjieba  （@azulores/jieba-hanlp，异步：cut() → Promise<string[]>）
// 同一时刻只能启用一个 provider（Cordis 会报 `service jieba has been registered`）。
//
// 兼容约定：消费方一律 `await ctx.jieba.cut(text)`。
// 同步 provider 的 `await string[]` 直接得到 string[]；异步 provider 等待 Promise。
//
// 这里**不**用 `declare module 'koishi'` 声明 Context.jieba：
// koishi-plugin-jieba 的 d.ts 已经把 jieba 声明成它自己的 Jieba 类，
// 再声明成别的类型会在「两个 provider 都安装」的工程里触发 TS2717。
// 用局部接口 + 运行时取值，本插件的 d.ts 就不会绑定任何具体 provider。

import type { Context } from 'koishi'

/** 可同步或异步返回的值；消费方统一 await 即可 */
export type Awaitable<T> = T | Promise<T>

/** 带字符偏移的分词结果（异步 provider 的增量能力） */
export interface Segment {
  word: string
  start: number
  end: number
}

/** `ctx.jieba` 的最小契约（两个 provider 都满足） */
export interface JiebaService {
  cut(sentence: string | Uint8Array, hmm?: boolean | null): Awaitable<string[]>
  cutAll?(sentence: string | Uint8Array): Awaitable<string[]>
  cutForSearch?(sentence: string | Uint8Array, hmm?: boolean | null): Awaitable<string[]>
  tag?(sentence: string | Uint8Array, hmm?: boolean | null): Awaitable<Array<{ word: string; tag: string }>>
  cutWithOffset?(sentence: string | Uint8Array): Awaitable<Segment[]>
}

/**
 * 取运行时的 jieba 服务并收窄成契约类型（`inject: ['jieba']` 保证它存在）。
 *
 * 经 `unknown` 转换而不是直接读 `ctx.jieba`：本工程刻意不声明 Context.jieba，
 * 以免与 koishi-plugin-jieba 的 d.ts 冲突（见文件头注释）。
 */
export function getJieba(ctx: Context): JiebaService {
  return (ctx as unknown as { jieba: JiebaService }).jieba
}
