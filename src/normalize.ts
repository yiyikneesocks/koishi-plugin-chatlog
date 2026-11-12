// 消息文本归一化：把 @ 元素 / CQ 码 / 表情转成可读占位符。
// 从原 dedide mock.ts 原样迁移，正则语义不变。

// 表情段：
//   CQ:      [CQ:face,id=264,raw=...]
//   satori:  <face id="264" name="捂脸"><img src="..."/></face>
//            （NapCat 的 face 元素内嵌一个 <img>，必须先整段吃掉，否则会被当成图片）
const FACE_CQ_RE = /\[CQ:(face|mface),([^\]]*)\]/gi
const FACE_EL_RE = /<face\b([^>]*)>(?:[\s\S]*?<\/face>)?/gi
const AT_ELEMENT_RE = /<at\b([^>]*?)\/?>/gi
const AT_CQ_RE = /\[CQ:at,([^\]]*)\]/gi

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const key = m[1] ?? m[3]
    const val = m[2] ?? m[4] ?? ''
    if (key) out[key] = val
  }
  return out
}

function parseCqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

function atToText(name?: string, id?: string): string {
  const n = (name || '').trim()
  if (n) return `@${n}`
  const i = (id || '').trim()
  return i ? `@${i}` : '@某人'
}

/**
 * 归一化消息：把 @ 元素/ CQ 码转成可读的 "@名字"，表情转成 [face:id] 占位符。
 * 只做「去段化」，其余内容原样保留。
 */
export function normalizeContent(content: string): string {
  if (!content) return content
  let out = content
    .replace(FACE_CQ_RE, (_, _t: string, raw: string) => {
      const a = parseCqParams(raw)
      return a.id ? `[face:${a.id}]` : ''
    })
    .replace(FACE_EL_RE, (_, raw: string) => {
      const a = parseAttrs(raw)
      return a.id ? `[face:${a.id}]` : ''
    })
  out = out.replace(AT_ELEMENT_RE, (_, raw: string) => {
    const a = parseAttrs(raw)
    return atToText(a.name, a.id || a.qq)
  })
  out = out.replace(AT_CQ_RE, (_, raw: string) => {
    const a = parseCqParams(raw)
    return atToText(a.name, a.qq || a.id)
  })
  return out
}

// 判断消息是否「纯媒体/无文字价值」——这类消息不存储、也不参与匹配。
// 注意：
//  - <at> 会先被转成 "@名字"（见 normalizeContent），不算媒体
//  - QQ 表情([CQ:face]) 会先转成占位符 [face:13]，只有「除表情外没有任何文字」时才丢弃
const MEDIA_RE = /\[CQ:(image|record|video|json|xml|share)/i
const URL_RE = /(?:https?:\/\/|www\.)[^\s\]}>,]+/i
const IMG_ELEMENT_RE = /<(image|img)\b/i

export function isMediaOnly(content: string): boolean {
  if (!content) return true
  if (MEDIA_RE.test(content)) return true
  // 先把 <face>…<img/>…</face> 整段去掉，再看还有没有真正的图片元素
  const withoutFaces = content
    .replace(/<face\b[^>]*>(?:[\s\S]*?<\/face>)?/gi, '')
    .replace(/<face\b[^>]*?\/>/gi, '')
  if (IMG_ELEMENT_RE.test(withoutFaces)) return true
  if (URL_RE.test(withoutFaces)) return true
  return false
}

/** 是否「只有表情、没有别的文字」（这类消息不存储） */
export function isFaceOnly(content: string): boolean {
  if (!content) return false
  if (!/\[CQ:(face|mface),/i.test(content) && !/<face\b/i.test(content)) return false
  const rest = content
    .replace(/\[CQ:(face|mface),[^\]]*\]/gi, '')
    .replace(/<face\b[^>]*>(?:[\s\S]*?<\/face>)?/gi, '')
    .replace(/<face\b[^>]*?\/>/gi, '')
    .trim()
  return rest.length === 0
}

// QQ 图片/媒体 CDN：这类链接是「图片资源」而不是用户分享的链接。
// 它们带 rkey、会过期，绝不能让它们进入 kind='url' 池（否则会回放失效链接）。
const QQ_MEDIA_HOST_RE = /^https?:\/\/(?:multimedia\.nt\.qq\.com\.cn|gchat\.qpic\.cn|qpic\.cn|wx\.qlogo\.cn|gxh\.vip\.qq\.com|p\.qpic\.cn)\//i
const IMAGE_LIKE_RE = /\.(?:jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i

/** 判断一个 URL 是否其实指向图片资源（不应作为「链接」存储） */
export function isImageUrl(url: string): boolean {
  if (!url) return true
  if (QQ_MEDIA_HOST_RE.test(url)) return true
  if (IMAGE_LIKE_RE.test(url)) return true
  return false
}

/** 从消息内容中提取第一个「真正的」URL（排除图片 CDN） */
export function extractUrl(content: string): string | null {
  const re = /https?:\/\/[^\s\]}>,]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const url = m[0].replace(/&amp;/g, '&')
    if (!isImageUrl(url)) return url
  }
  return null
}

/** 从消息内容中提取第一个图片 URL（CQ 码 / <image> / 裸 URL） */
export function extractImageUrl(content: string): string | null {
  if (!content) return null

  // Ⅰ. 先判断「这确实是一条图片/表情消息」。
  //    QQ 的「动画表情」= [CQ:image,sub_type=1]，本质上就是图片/动图，
  //    必须走图片通道，绝不能落到 URL 分支（否则会回放过期的 CDN 链接）。
  const isImageLike =
    /\[CQ:(image|mface)\b/i.test(content) ||
    /<img\b/i.test(content) ||
    /\bsub_type=["']?1\b/i.test(content)

  let m = content.match(/\[CQ:image[^\]]*?url=([^,\]]+)/i)
  if (m) return m[1].replace(/&amp;/g, '&')
  m = content.match(/<img?\b[^>]*?\b(?:url|src)="([^"]+)"/i) || content.match(/<image\b[^>]*?\b(?:url|src)="([^"]+)"/i)
  if (m) return m[1].replace(/&amp;/g, '&')
  // CQ 码只有 file= 没有 url=（NapCat 某些情况）：无法下载，但明确是图片
  if (isImageLike && /\[CQ:image\b[^\]]*?file=([^,\]]+)/i.test(content)) return null
  m = content.match(/https?:\/\/[^\s\]}>,]+\.(?:jpe?g|png|gif|webp|bmp)(?:\?[^\s\]}>,]*)?/i)
  if (m) return m[0].replace(/&amp;/g, '&')
  m = content.match(/https?:\/\/(?:multimedia\.nt\.qq\.com\.cn|gchat\.qpic\.cn|qpic\.cn|gxh\.vip\.qq\.com|p\.qpic\.cn)\/[^\s\]}>,]+/i)
  if (m) return m[0].replace(/&amp;/g, '&')
  return null
}
