import { h } from 'koishi'

/**
 * 把存储用的占位符还原成可发送的元素：
 *   [face:13] → <face id="13"/>
 * 其余文字保持原样，拼接成一条消息。
 */
export function restoreFaces(text: string): any {
  const parts: any[] = []
  const re = /\[face:(\d+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(h('text', { content: text.slice(last, m.index) }))
    parts.push(h('face', { id: m[1] }))
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(h('text', { content: text.slice(last) }))
  return parts.length ? parts : text
}
