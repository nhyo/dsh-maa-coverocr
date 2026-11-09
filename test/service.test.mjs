import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveVideoId, USER_AGENT } from '../src/bilibili.js'
import { apply, API_VERSION, createCoverocrService, SERVICE_NAME } from '../src/index.js'

const NAMES = ['维什戴尔', '结城理', '白面鸮', '冻河', '圣聆初雪', '凯尔希', '史尔特尔']
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

function fakeBilibili(overrides = {}) {
  const calls = []
  const routes = {
    '/x/web-interface/view': { code: 0, data: { bvid: 'BV1upWJ6YEf3', aid: 42, title: '【明日方舟】TL-EX-8突袭 5人摆完挂机', desc: '42 单核也行 maa://12345', owner: { mid: 7, name: 'UP' }, pic: 'http://i1.hdslb.com/bfs/archive/abc.jpg', duration: 188 } },
    '/x/tag/archive/tags': { code: 0, data: [{ tag_name: '作业' }, { tag_name: '冻河' }] },
    '/x/v2/reply': { code: 0, data: { upper: { top: { rpid: 1, mid: 7, content: { message: '置顶：凯尔希可换' } } }, replies: [
      { rpid: 2, mid: 99, content: { message: '没有结城理怎么办' } },
      { rpid: 3, mid: 7, content: { message: 'UP 补充：白面鸮练度够就行' } },
    ] } },
    ...overrides,
  }
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const parsed = new URL(url)
    if (parsed.hostname === 'i1.hdslb.com') return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    const body = routes[parsed.pathname]
    if (body instanceof Error) throw body
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

function fakeEngine(lines) {
  const seen = []
  return {
    seen,
    getEngine: resourceDir => ({ ready: Promise.resolve(), async recognize(bytes) { seen.push({ resourceDir, bytes }); return { width: 1280, height: 720, lines } } }),
  }
}

test('the plugin entry provides the versioned service', () => {
  const provided = {}
  apply({ provide: (name, value) => { provided[name] = value } })
  assert.equal(SERVICE_NAME, 'maaCoverocr')
  assert.equal(provided.maaCoverocr.apiVersion, API_VERSION)
  assert.equal(typeof provided.maaCoverocr.analyzeVideo, 'function')
})

test('resolves BV ids, video URLs and b23.tv short links; rejects other hosts', async () => {
  assert.equal(await resolveVideoId('BV1upWJ6YEf3'), 'BV1upWJ6YEf3')
  assert.equal(await resolveVideoId('https://www.bilibili.com/video/BV1upWJ6YEf3/?spm=x'), 'BV1upWJ6YEf3')
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://www.bilibili.com/video/BV1upWJ6YEf3' } })
  assert.equal(await resolveVideoId('https://b23.tv/abcd', { fetchImpl }), 'BV1upWJ6YEf3')
  const evil = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/video/BV1upWJ6YEf3' } })
  await assert.rejects(resolveVideoId('https://b23.tv/abcd', { fetchImpl: evil }), /没有跳转到 bilibili\.com/u)
  await assert.rejects(resolveVideoId('https://example.com/video/BV1upWJ6YEf3'), /只支持 bilibili\.com/u)
})

test('analyzes a video from text and cover, with sources and honest requests', async () => {
  const { fetchImpl, calls } = fakeBilibili()
  const engine = fakeEngine([
    { text: '快捷编队', confidence: 1, x: 0, y: 0, w: 80, h: 20 },
    { text: '维什戴尔', confidence: 0.9, x: 0, y: 100, w: 60, h: 16 },
    { text: '结城理', confidence: 0.99, x: 80, y: 100, w: 50, h: 16 },
  ])
  const service = createCoverocrService({ fetchImpl, getEngine: engine.getEngine })
  const result = await service.analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES, resourceDir: 'C:/maa/resource' })

  assert.equal(result.video.url, 'https://www.bilibili.com/video/BV1upWJ6YEf3/')
  assert.equal(result.cover.status, 'recognized')
  assert.equal(result.cover.layout, 'squad')
  assert.deepEqual(result.maaCodes, ['12345'])
  const byName = Object.fromEntries(result.operators.map(item => [item.name, item]))
  assert.deepEqual(byName.维什戴尔, { name: '维什戴尔', certainty: 'certain', sources: ['cover'] })
  assert.deepEqual(byName.史尔特尔.sources, ['description'], 'alias 42 in the description')
  assert.deepEqual(byName.冻河.sources, ['tags'])
  assert.ok(byName.凯尔希 && byName.白面鸮, 'pinned comment and the uploader\'s own comment count')
  assert.equal(result.text.comments.includes('结城理'), false, 'other viewers\' comments are ignored')

  assert.equal(engine.seen[0].resourceDir, 'C:/maa/resource')
  const cover = calls.find(call => call.url.includes('hdslb.com'))
  assert.equal(cover.url, 'https://i1.hdslb.com/bfs/archive/abc.jpg@1280w.jpg')
  assert.ok(calls.every(call => call.init.headers['user-agent'] === USER_AGENT), 'every request identifies the plugin')
})

test('a missing model directory or a failing engine leaves the text result usable', async () => {
  const { fetchImpl } = fakeBilibili()
  const service = createCoverocrService({ fetchImpl, getEngine: () => ({ ready: Promise.reject(new Error('no onnxruntime')) }) })
  const noDir = await service.analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES })
  assert.equal(noDir.cover.status, 'unavailable')
  const failing = await service.analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES, resourceDir: 'C:/maa/resource' })
  assert.equal(failing.cover.status, 'unavailable')
  assert.match(failing.warnings.join('\n'), /识别模型加载失败：no onnxruntime/u)
  assert.ok(failing.operators.some(item => item.name === '史尔特尔'))
})

test('a timed-out cover download is retried once', async () => {
  const { fetchImpl: base } = fakeBilibili()
  let coverCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).includes('hdslb.com') && coverCalls++ === 0) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return base(url, init)
  }
  const engine = fakeEngine([{ text: '冻河', confidence: 1, x: 0, y: 0, w: 30, h: 16 }])
  const result = await createCoverocrService({ fetchImpl, getEngine: engine.getEngine }).analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES, resourceDir: 'x' })
  assert.equal(coverCalls, 2)
  assert.equal(result.cover.status, 'recognized')

  let failures = 0
  const alwaysTimeout = async (url, init) => {
    if (String(url).includes('hdslb.com')) { failures += 1; throw new DOMException('timeout', 'TimeoutError') }
    return base(url, init)
  }
  const failed = await createCoverocrService({ fetchImpl: alwaysTimeout, getEngine: engine.getEngine }).analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES, resourceDir: 'x' })
  assert.equal(failures, 2, 'only one retry')
  assert.equal(failed.cover.status, 'failed')
})

test('tag and comment failures are warnings; a refused view request is an error', async () => {
  const partial = fakeBilibili({ '/x/tag/archive/tags': new Error('network down'), '/x/v2/reply': { code: -404, message: '啥都木有' } })
  const result = await createCoverocrService({ fetchImpl: partial.fetchImpl, getEngine: fakeEngine([]).getEngine })
    .analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES, resourceDir: 'x' })
  assert.equal(result.warnings.length, 2)
  assert.equal(result.cover.status, 'no-operators')

  const refused = fakeBilibili({ '/x/web-interface/view': { code: -412, message: '请求被拦截' } })
  await assert.rejects(createCoverocrService({ fetchImpl: refused.fetchImpl }).analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: NAMES }), /B 站接口错误 -412/u)
  await assert.rejects(createCoverocrService({ fetchImpl: refused.fetchImpl }).analyzeVideo({ video: 'BV1upWJ6YEf3', operatorNames: [] }), /没有提供干员名单/u)
})
