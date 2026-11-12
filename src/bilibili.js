// Stateful read-only Bilibili client. It never requests playback URLs or video streams.
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const API = 'https://api.bilibili.com'
const BVID = /^BV[0-9A-Za-z]{10}$/u
const RISK_CODES = new Set([-352, -412, -509])
const RISK_MINUTES = [10, 30, 60, 120]
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const MAX_JSON = 2 * 1024 * 1024
const MAX_COVER = 8 * 1024 * 1024

export class BilibiliError extends Error {
  constructor(stage, message, details = {}) {
    super(`B 站${stage}失败：${message}`)
    this.name = 'BilibiliError'; this.stage = stage; Object.assign(this, details)
  }
}

export function createBilibiliClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const stateDir = options.stateDir ?? path.join(os.homedir(), '.dsh-maa-coverocr')
  const persistent = !options.fetchImpl || options.stateDir !== undefined
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const minInterval = options.minIntervalMs ?? (options.fetchImpl ? 0 : 800)
  const jitter = options.jitterMs ?? (options.fetchImpl ? 0 : 500)
  let loaded = false
  let session = { cookie: '', buvid3: '', buvid4: '', wbi: null }
  let risk = { until: 0, strikes: 0, code: 0, at: '' }
  let lastRequest = 0
  let queue = Promise.resolve()

  async function load() {
    if (loaded) return
    loaded = true
    if (persistent) {
      session = { ...session, ...await readJson(path.join(stateDir, 'bilibili-session.json')) }
      risk = { ...risk, ...await readJson(path.join(stateDir, 'bilibili-risk.json')) }
    }
  }
  const saveSession = () => persistent ? writePrivateJson(stateDir, 'bilibili-session.json', session) : Promise.resolve()
  const saveRisk = () => persistent ? writePrivateJson(stateDir, 'bilibili-risk.json', risk) : Promise.resolve()

  async function throttle(fn, signal) {
    const run = queue.then(async () => {
      const gap = Math.max(0, minInterval) + Math.floor(random() * Math.max(0, jitter))
      const wait = gap - (now() - lastRequest)
      if (wait > 0) await delay(wait, signal)
      lastRequest = now()
      return await fn()
    })
    queue = run.catch(() => {})
    return await run
  }

  async function raw(url, request = {}) {
    await load()
    const timeout = AbortSignal.timeout(request.timeoutMs ?? 15_000)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
    return await throttle(() => fetchImpl(url, {
      signal, redirect: request.redirect ?? 'follow', headers: {
        'user-agent': USER_AGENT,
        accept: request.accept ?? 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: request.referer ?? 'https://www.bilibili.com/',
        ...(cookieHeader(session) ? { cookie: cookieHeader(session) } : {}),
      },
    }), request.signal)
  }

  async function noteRisk(code) {
    const strikes = Math.min(RISK_MINUTES.length, Math.max(0, Number(risk.strikes) || 0) + 1)
    const minutes = RISK_MINUTES[strikes - 1]
    risk = { until: now() + minutes * 60_000, strikes, code, at: new Date(now()).toISOString() }
    await saveRisk()
    return minutes
  }

  async function json(url, request = {}) {
    await load()
    if (!request.ignoreCooldown && now() < Number(risk.until)) {
      const minutes = Math.max(1, Math.ceil((Number(risk.until) - now()) / 60_000))
      throw new BilibiliError(request.stage ?? '请求', `风控冷却中，约 ${minutes} 分钟后再试。`, { code: 'COOLDOWN', cooldownUntil: risk.until })
    }
    const response = await raw(url, request)
    if (!response.ok) throw new BilibiliError(request.stage ?? '请求', `HTTP ${response.status}`)
    const bytes = await limited(response, MAX_JSON)
    let body
    try { body = JSON.parse(bytes.toString('utf8')) } catch { throw new BilibiliError(request.stage ?? '请求', '返回的不是 JSON。') }
    const code = Number(body?.code)
    if (code !== 0 && !request.allowCodes?.includes(code)) {
      if (RISK_CODES.has(code)) {
        if (request.deferRisk) throw new BilibiliError(request.stage ?? '请求', `接口错误 ${code}：${String(body?.message ?? '')}`, { code })
        const minutes = await noteRisk(code)
        throw new BilibiliError(request.stage ?? '请求', `接口错误 ${code}：${String(body?.message ?? '')}；已冷却 ${minutes} 分钟。`, { code, cooldownUntil: risk.until })
      }
      throw new BilibiliError(request.stage ?? '请求', `接口错误 ${code}：${String(body?.message ?? '')}`, { code })
    }
    return body
  }

  async function ensureBuvid(request = {}) {
    await load()
    if (session.buvid3) return
    const body = await json(`${API}/x/frontend/finger/spi`, { ...request, stage: '获取设备标识', ignoreCooldown: true })
    if (!body?.data?.b_3) throw new BilibiliError('获取设备标识', '响应里没有 buvid3。')
    session.buvid3 = String(body.data.b_3); session.buvid4 = String(body.data.b_4 ?? '')
    await saveSession()
  }

  async function ensureWbi(request = {}, force = false) {
    await load()
    if (!force && session.wbi?.img && session.wbi?.sub && now() - Number(session.wbi.at) < 6 * 60 * 60_000) return session.wbi
    await ensureBuvid(request)
    const body = await json(`${API}/x/web-interface/nav`, { ...request, stage: '获取 WBI 密钥', allowCodes: [-101], ignoreCooldown: true })
    const img = filename(body?.data?.wbi_img?.img_url); const sub = filename(body?.data?.wbi_img?.sub_url)
    if (!img || !sub) throw new BilibiliError('获取 WBI 密钥', '响应里没有签名密钥。')
    session.wbi = { img, sub, at: now() }; await saveSession(); return session.wbi
  }

  async function signed(pathname, params, request) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const keys = await ensureWbi(request, attempt === 1)
      try {
        return await json(`${API}${pathname}?${sign(params, keys, now())}`, { ...request, deferRisk: attempt === 0 })
      } catch (error) {
        if (attempt === 0 && error instanceof BilibiliError && RISK_CODES.has(error.code)) continue
        throw error
      }
    }
  }

  async function search(query, request = {}) {
    const rawQuery = String(query ?? '').trim()
    if (!rawQuery) throw new TypeError('搜索关键词不能为空。')
    const keyword = /明日方舟/u.test(rawQuery) ? rawQuery : `明日方舟 ${rawQuery}`
    await ensureBuvid(request)
    const limit = Math.min(10, Math.max(1, Number(request.limit) || 5))
    const body = await signed('/x/web-interface/search/type', { search_type: 'video', keyword, page: 1, page_size: Math.max(5, limit) }, {
      ...request, stage: '搜索视频', referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
    })
    return (Array.isArray(body?.data?.result) ? body.data.result : []).map(row => ({
      bvid: String(row?.bvid ?? ''), title: stripHtml(String(row?.title ?? '')), owner: String(row?.author ?? ''),
      cover: normalizeCover(row?.pic), duration: String(row?.duration ?? ''),
    })).filter(row => BVID.test(row.bvid)).slice(0, limit)
  }

  async function video(bvid, request = {}) {
    await ensureBuvid(request)
    const body = await json(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { ...request, stage: '读取视频详情' })
    const data = body?.data
    if (!data || typeof data !== 'object') throw new BilibiliError('读取视频详情', '没有返回视频信息。')
    const value = {
      bvid: String(data.bvid ?? bvid), aid: Number(data.aid), url: `https://www.bilibili.com/video/${data.bvid ?? bvid}/`,
      title: String(data.title ?? ''), description: String(data.desc ?? ''), owner: { mid: Number(data.owner?.mid), name: String(data.owner?.name ?? '') },
      cover: normalizeCover(data.pic), duration: Number(data.duration) || 0, tags: [], uploaderComments: [],
    }
    const warnings = []
    if (request.coverOnly) return { video: value, warnings }
    try {
      const tags = await json(`${API}/x/tag/archive/tags?bvid=${encodeURIComponent(value.bvid)}`, { ...request, stage: '读取标签' })
      value.tags = (Array.isArray(tags?.data) ? tags.data : []).map(tag => String(tag?.tag_name ?? '')).filter(Boolean)
    } catch (error) { warnings.push(messageOf(error)) }
    try { value.uploaderComments = await comments(value.aid, value.owner.mid, request) } catch (error) { warnings.push(messageOf(error)) }
    return { video: value, warnings }
  }

  async function comments(aid, ownerMid, request) {
    const body = await json(`${API}/x/v2/reply?type=1&oid=${aid}&sort=1&ps=20`, { ...request, stage: '读取评论' })
    const data = body?.data ?? {}; const replies = [data.upper?.top, ...(Array.isArray(data.replies) ? data.replies : [])].filter(Boolean)
    const texts = []; const seen = new Set()
    for (const reply of replies) {
      if (reply !== data.upper?.top && Number(reply?.mid) !== ownerMid) continue
      const text = String(reply?.content?.message ?? '').trim()
      if (!text || seen.has(reply.rpid)) continue
      seen.add(reply.rpid); texts.push(text.slice(0, 2000))
    }
    return texts
  }

  async function cover(coverUrl, request = {}) {
    const url = new URL(coverUrl)
    if (!/(^|\.)hdslb\.com$/u.test(url.hostname.toLowerCase())) throw new Error('封面地址不在 B 站图片域名下，已拒绝。')
    url.protocol = 'https:'; url.pathname = `${url.pathname.replace(/@.*$/u, '')}@1280w.jpg`
    const response = await raw(url.href, { ...request, accept: 'image/jpeg,*/*;q=0.1' })
    if (!response.ok) throw new Error(`封面下载失败：HTTP ${response.status}`)
    return { url: url.href, bytes: await limited(response, MAX_COVER) }
  }

  async function setCookie(cookie) { await load(); session.cookie = String(cookie ?? '').trim().replace(/[\r\n]+/gu, ''); await saveSession(); return { configured: Boolean(session.cookie) } }
  async function status() { await load(); return { hasCookie: Boolean(session.cookie), hasBuvid: Boolean(session.buvid3), cooldownUntil: Number(risk.until) || 0, cooldownMs: Math.max(0, Number(risk.until) - now()), strikes: Number(risk.strikes) || 0, lastRiskCode: Number(risk.code) || 0 } }
  return Object.freeze({ search, video, cover, setCookie, status })
}

let defaultClient
function clientFor(options = {}) {
  if (options.client) return options.client
  if (options.fetchImpl || options.stateDir) return createBilibiliClient(options)
  return defaultClient ??= createBilibiliClient()
}

export async function resolveVideoId(input, options = {}) {
  const raw = String(input ?? '').trim()
  if (BVID.test(raw)) return raw
  let url
  try { url = new URL(raw) } catch { throw new TypeError(`无法识别的视频链接：${raw.slice(0, 80)}`) }
  if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('只支持 http/https 的 B 站链接。')
  const host = url.hostname.toLowerCase()
  if (host === 'b23.tv') {
    const response = await (options.fetchImpl ?? globalThis.fetch)(`https://b23.tv${url.pathname}`, { redirect: 'manual', signal: options.signal })
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
export async function searchVideos(query, options = {}) { return await clientFor(options).search(query, options) }
export async function fetchVideo(bvid, options = {}) { return await clientFor(options).video(bvid, options) }
export async function fetchCover(url, options = {}) { return await clientFor(options).cover(url, options) }

function sign(values, keys, now) {
  const mixin = MIXIN.map(index => `${keys.img}${keys.sub}`[index] ?? '').join('').slice(0, 32)
  const all = { ...values, wts: Math.floor(now / 1000) }
  const query = Object.keys(all).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/gu, ''))}`).join('&')
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`
}
function filename(url) { return String(url ?? '').match(/\/([^/?]+)\.(?:png|jpg)(?:\?|$)/u)?.[1] ?? '' }
function stripHtml(value) { return value.replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&') }
function normalizeCover(value) { const raw = String(value ?? ''); return raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:/u, 'https:') }
function cookieHeader(s) { return [s.cookie, s.buvid3 && `buvid3=${s.buvid3}`, s.buvid4 && `buvid4=${s.buvid4}`].filter(Boolean).join('; ') }
async function readJson(file) { try { const value = JSON.parse(await readFile(file, 'utf8')); return value && typeof value === 'object' ? value : {} } catch { return {} } }
async function writePrivateJson(dir, name, value) { await mkdir(dir, { recursive: true }); const target = path.join(dir, name); const temp = `${target}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, target); try { await chmod(target, 0o600) } catch {} }
async function limited(response, max) { const declared = Number(response.headers?.get?.('content-length')); if (Number.isFinite(declared) && declared > max) throw new Error('响应超过安全上限。'); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > max) throw new Error('响应超过安全上限。'); return bytes }
async function delay(ms, signal) { if (!signal) return await new Promise(resolve => setTimeout(resolve, ms)); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true }) }) }
function messageOf(error) { return error instanceof Error ? error.message : String(error) }
