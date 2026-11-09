// Read-only access to one Bilibili video: its public metadata, tags, the
// uploader's own comments and its cover. Requests identify this plugin
// honestly; if Bilibili refuses them, the error is reported as is.
//
// Keyword search is intentionally not offered: Bilibili's search API rejects
// non-browser clients, and this plugin does not pretend to be a browser.

export const USER_AGENT = 'dsh-maa-coverocr (+https://github.com/nhyo/dsh-maa-coverocr)'
const API = 'https://api.bilibili.com'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_COVER_BYTES = 8 * 1024 * 1024
const COVER_WIDTH = 1280
const BVID = /^BV[0-9A-Za-z]{10}$/u

/** Accepts a BV id, a bilibili.com video URL or a b23.tv short link. */
export async function resolveVideoId(input, options = {}) {
  const raw = String(input ?? '').trim()
  if (BVID.test(raw)) return raw
  let url
  try { url = new URL(raw) } catch { throw new TypeError(`无法识别的视频链接：${raw.slice(0, 80)}`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('只支持 http/https 的 B 站链接。')
  const host = url.hostname.toLowerCase()
  if (host === 'b23.tv') {
    const response = await request(`https://b23.tv${url.pathname}`, { ...options, redirect: 'manual' })
    const location = response.headers.get('location')
    if (!location) throw new Error(`短链接没有跳转目标（HTTP ${response.status}）。`)
    const target = new URL(location, 'https://b23.tv')
    if (!/(^|\.)bilibili\.com$/u.test(target.hostname.toLowerCase())) throw new Error('短链接没有跳转到 bilibili.com，已拒绝。')
    return resolveVideoId(target.href, options)
  }
  if (!/(^|\.)bilibili\.com$/u.test(host)) throw new TypeError('只支持 bilibili.com 或 b23.tv 的视频链接。')
  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/u)
  if (!match) throw new TypeError('链接里没有 BV 号。')
  return match[1]
}

export async function fetchVideo(bvid, options = {}) {
  const view = await apiJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, options)
  const data = view?.data
  if (!data || typeof data !== 'object') throw new Error('B 站没有返回视频信息。')
  const video = {
    bvid: String(data.bvid ?? bvid),
    aid: Number(data.aid),
    url: `https://www.bilibili.com/video/${data.bvid ?? bvid}/`,
    title: String(data.title ?? ''),
    description: String(data.desc ?? ''),
    owner: { mid: Number(data.owner?.mid), name: String(data.owner?.name ?? '') },
    cover: typeof data.pic === 'string' ? data.pic.replace(/^http:/u, 'https:') : '',
    duration: Number(data.duration) || 0,
    tags: [],
    uploaderComments: [],
  }
  const warnings = []
  try {
    const tags = await apiJson(`${API}/x/tag/archive/tags?bvid=${encodeURIComponent(video.bvid)}`, options)
    video.tags = (Array.isArray(tags?.data) ? tags.data : []).map(tag => String(tag?.tag_name ?? '')).filter(Boolean)
  } catch (error) {
    warnings.push(`标签读取失败：${messageOf(error)}`)
  }
  if (Number.isFinite(video.aid)) {
    try {
      video.uploaderComments = await fetchUploaderComments(video.aid, video.owner.mid, options)
    } catch (error) {
      warnings.push(`评论读取失败：${messageOf(error)}`)
    }
  }
  return { video, warnings }
}

// Only the pinned comment and comments written by the uploader: other viewers
// name operators they do not have ("没有 42 怎么办"), which is not the lineup.
async function fetchUploaderComments(aid, ownerMid, options) {
  const body = await apiJson(`${API}/x/v2/reply?type=1&oid=${aid}&sort=1&ps=20`, options)
  const data = body?.data ?? {}
  const replies = [data.upper?.top, ...(Array.isArray(data.replies) ? data.replies : [])].filter(Boolean)
  const texts = []
  const seen = new Set()
  for (const reply of replies) {
    const pinned = reply === data.upper?.top
    if (!pinned && Number(reply?.mid) !== ownerMid) continue
    const text = String(reply?.content?.message ?? '').trim()
    if (text === '' || seen.has(reply.rpid)) continue
    seen.add(reply.rpid)
    texts.push(text.slice(0, 2000))
  }
  return texts
}

/** The cover as a JPEG at most COVER_WIDTH wide (Bilibili's image service converts it). */
export async function fetchCover(coverUrl, options = {}) {
  const url = new URL(coverUrl)
  if (!/(^|\.)hdslb\.com$/u.test(url.hostname.toLowerCase())) throw new Error('封面地址不在 B 站图片域名下，已拒绝。')
  url.protocol = 'https:'
  url.pathname = `${url.pathname.replace(/@.*$/u, '')}@${COVER_WIDTH}w.jpg`
  const response = await request(url.href, options)
  if (!response.ok) throw new Error(`封面下载失败：HTTP ${response.status}`)
  const bytes = await readLimited(response, MAX_COVER_BYTES)
  return { url: url.href, bytes }
}

async function apiJson(url, options) {
  const response = await request(url, options)
  if (!response.ok) throw new Error(`B 站接口返回 HTTP ${response.status}`)
  const text = (await readLimited(response, MAX_JSON_BYTES)).toString('utf8')
  let body
  try { body = JSON.parse(text) } catch { throw new Error('B 站返回的不是 JSON（可能被拒绝访问）。') }
  if (body?.code !== 0) throw new Error(`B 站接口错误 ${body?.code}：${String(body?.message ?? '').slice(0, 80)}`)
  return body
}

async function request(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  return await fetchImpl(url, { signal, redirect: options.redirect ?? 'follow', headers: { 'user-agent': USER_AGENT, accept: 'application/json, image/jpeg;q=0.9, */*;q=0.1' } })
}

async function readLimited(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('响应超过安全上限。')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error('响应超过安全上限。')
  return bytes
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
