// The `maaCoverocr` service consumed by dsh-maa-cli (API version 1).
//
//   analyzeVideo({ video, operatorNames, resourceDir, signal }) →
//     { video, operators, cover, text, maaCodes, warnings }
//
// `operatorNames` and `resourceDir` come from dsh-maa-cli (MAA's
// battle_data.json names and the MAA resource directory holding the OCR
// models), so this plugin never needs dsh-maa-cli's internals.
import { readFileSync } from 'node:fs'
import { fetchCover, fetchVideo, resolveVideoId } from './bilibili.js'
import { analyzeCoverLines, createNameIndex, extractMaaCodes, findOperatorsInText, mergeLineup } from './lineup.js'
import { getOcrEngine } from './ocr.js'

export const SERVICE_NAME = 'maaCoverocr'
export const API_VERSION = 1
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export function createCoverocrService(options = {}) {
  const getEngine = options.getEngine ?? getOcrEngine
  return Object.freeze({
    apiVersion: API_VERSION,
    packageName: 'dsh-maa-coverocr',
    version: PACKAGE_VERSION,
    async analyzeVideo(request = {}) {
      const io = { fetchImpl: options.fetchImpl, signal: request.signal }
      const index = createNameIndex(request.operatorNames, request.aliases)
      if (index.names.size === 0) throw new Error('没有提供干员名单，无法识别阵容。')
      const bvid = await resolveVideoId(request.video, io)
      const { video, warnings } = await fetchVideo(bvid, io)

      const text = {
        title: findOperatorsInText(video.title, index).map(item => item.name),
        description: findOperatorsInText(video.description, index).map(item => item.name),
        tags: [...new Set(video.tags.flatMap(tag => findOperatorsInText(tag, index).map(item => item.name)))],
        comments: [...new Set(video.uploaderComments.flatMap(comment => findOperatorsInText(comment, index).map(item => item.name)))],
      }
      const cover = await readCover(video, request, io, getEngine, index)
      if (cover.warning) warnings.push(cover.warning)

      const operators = mergeLineup([
        { source: 'cover', operators: cover.operators },
        { source: 'title', operators: text.title.map(name => ({ name, certainty: 'likely' })) },
        { source: 'description', operators: text.description.map(name => ({ name, certainty: 'likely' })) },
        { source: 'tags', operators: text.tags.map(name => ({ name, certainty: 'likely' })) },
        { source: 'comments', operators: text.comments.map(name => ({ name, certainty: 'likely' })) },
      ])
      return {
        video: { bvid: video.bvid, url: video.url, title: video.title, owner: video.owner.name, duration: video.duration, cover: video.cover },
        operators,
        cover: { status: cover.status, layout: cover.layout, detail: cover.detail, ignored: cover.ignored },
        text,
        maaCodes: extractMaaCodes(video.title, video.description, ...video.uploaderComments),
        warnings,
      }
    },
  })
}

async function readCover(video, request, io, getEngine, index) {
  const empty = { operators: [], layout: 'unknown', ignored: [] }
  if (!video.cover) return { ...empty, status: 'unavailable', detail: '视频没有封面地址。' }
  if (typeof request.resourceDir !== 'string' || request.resourceDir === '') {
    return { ...empty, status: 'unavailable', detail: '没有提供 MAA 资源目录，无法加载识别模型。' }
  }
  let engine
  try {
    engine = getEngine(request.resourceDir)
    await engine.ready
  } catch (error) {
    const detail = `识别模型加载失败：${messageOf(error)}`
    return { ...empty, status: 'unavailable', detail, warning: detail }
  }
  try {
    const bytes = await fetchCoverWithRetry(video.cover, io)
    const result = await engine.recognize(bytes)
    const analysis = analyzeCoverLines(result.lines, index)
    return {
      status: analysis.operators.length > 0 ? 'recognized' : 'no-operators',
      layout: analysis.layout,
      detail: analysis.operators.length > 0 ? '' : '封面上没有识别出干员名。',
      operators: analysis.operators,
      ignored: analysis.ignored,
    }
  } catch (error) {
    if (io.signal?.aborted) throw error
    const detail = `封面识别失败：${messageOf(error)}`
    return { ...empty, status: 'failed', detail, warning: detail }
  }
}

// The first cover request of a fresh DSH process was once seen stalling past
// its timeout while every later one took ~0.2 s, so a timeout gets one retry.
async function fetchCoverWithRetry(url, io) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await fetchCover(url, { ...io, timeoutMs: COVER_TIMEOUT_MS })).bytes
    } catch (error) {
      if (attempt >= 1 || io.signal?.aborted || error?.name !== 'TimeoutError') throw error
    }
  }
}

const COVER_TIMEOUT_MS = 30_000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
