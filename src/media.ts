// 媒体（图片）存储：下载落盘 + 总量控制。
// 从原 dedide mock.ts 原样迁移，仅 assetsDir 默认值改为 data/assets/chatlog。
import { Context } from 'koishi'
import { promises as fsp } from 'fs'
import { join, extname } from 'path'
import type { MediaConfig } from './types'

function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const e = extname(p).toLowerCase()
    if (e && /^\.(jpe?g|png|gif|webp|bmp)$/.test(e)) return e
  } catch { }
  return '.jpg'
}

/** 读取目录总大小 */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    try {
      const st = await fsp.stat(join(dir, name))
      if (st.isFile()) total += st.size
    } catch { }
  }
  return total
}

/**
 * 下载图片并落盘。超过单图上限则丢弃并返回 null。
 * 落盘后检查总占用，超出上限则按修改时间从旧到新删除。
 */
export async function saveImage(
  ctx: Context,
  url: string,
  cfg: MediaConfig = {},
): Promise<string | null> {
  const maxBytes = cfg.maxImageBytes ?? 20 * 1024 * 1024
  const maxTotal = cfg.maxTotalBytes ?? 2 * 1024 * 1024 * 1024
  const root = join(ctx.baseDir, cfg.assetsDir ?? 'data/assets/chatlog')

  try {
    await fsp.mkdir(root, { recursive: true })

    const res = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 30000 })
    const buf = Buffer.from(res)
    if (!buf?.length) return null
    if (buf.length > maxBytes) {
      ctx.logger('chatlog').debug('跳过超限图片 (%d bytes)', buf.length)
      return null
    }

    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extFromUrl(url)}`
    const file = join(root, name)
    await fsp.writeFile(file, buf)

    // 总量控制：从旧到新删
    let total = await dirSize(root)
    if (total > maxTotal) {
      const files = await fsp.readdir(root)
      const stats = await Promise.all(files.map(async (f) => {
        try { return { f, st: await fsp.stat(join(root, f)) } } catch { return null }
      }))
      const sorted = stats.filter(Boolean).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs) as any[]
      for (const { f, st } of sorted) {
        if (total <= maxTotal) break
        if (join(root, f) === file) continue  // 别删刚存的
        try { await fsp.unlink(join(root, f)); total -= st.size } catch { }
      }
    }
    return file
  } catch (e: any) {
    ctx.logger('chatlog').warn('图片保存失败:', e?.message || e)
    return null
  }
}

/** 删除一张已存储的图片（回放后调用） */
export async function removeImage(file: string): Promise<void> {
  if (!file) return
  try { await fsp.unlink(file) } catch { }
}
