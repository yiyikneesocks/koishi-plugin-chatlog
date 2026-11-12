// 纯函数统一出口（不触发 Service 初始化，供消费插件 import）
export { ingestMessage } from './ingest'
export { catchupGuild, elementsToContent } from './catchup'
export type { CatchupOptions, CatchupResult } from './catchup'
export { extractImageUrl, extractUrl, normalizeContent, isMediaOnly, isFaceOnly, isImageUrl } from './normalize'
export { saveImage, removeImage } from './media'
export type { MediaConfig } from './types'
