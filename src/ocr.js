// Cover OCR with MAA's own PaddleOCR models (resource/PaddleOCR/{det,rec}),
// run through onnxruntime-node. Nothing here is downloaded: the models come
// from the MAA runtime dsh-maa-cli already installed, and the caller passes
// that resource directory in.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import jpeg from 'jpeg-js'

const DET_MAX_SIDE = 960
const DET_THRESHOLD = 0.3
const DET_BOX_SCORE = 0.6
const DET_UNCLIP_RATIO = 1.5
const DET_MIN_AREA = 10
const REC_HEIGHT = 48
const REC_MAX_WIDTH = 1280
const MAX_BOXES = 80
const MAX_IMAGE_PIXELS = 4096 * 4096
// Detection mean/std in BGR order: PaddleOCR reads images with OpenCV.
const DET_MEAN = [0.406, 0.456, 0.485]
const DET_STD = [0.225, 0.224, 0.229]

const engines = new Map()

/**
 * One engine per model directory, created on first use and kept for the life
 * of the plugin process: loading both models takes ~0.5 s, a cover afterwards
 * well under a second.
 */
export function getOcrEngine(resourceDir, options = {}) {
  const key = path.resolve(resourceDir)
  let engine = engines.get(key)
  if (engine === undefined) {
    engine = createOcrEngine(key, options)
    engines.set(key, engine)
    // A failed load must not poison the cache: the next call retries.
    engine.ready.catch(() => engines.delete(key))
  }
  return engine
}

export function createOcrEngine(resourceDir, options = {}) {
  const ready = (async () => {
    const ort = options.ort ?? (await import('onnxruntime-node')).default
    const base = path.join(resourceDir, 'PaddleOCR')
    const [det, rec, keysText] = await Promise.all([
      ort.InferenceSession.create(path.join(base, 'det', 'inference.onnx')),
      ort.InferenceSession.create(path.join(base, 'rec', 'inference.onnx')),
      readFile(path.join(base, 'rec', 'keys.txt'), 'utf8'),
    ])
    // CTC: index 0 is the blank, then the dictionary, then a space.
    const keys = ['', ...keysText.split(/\r?\n/u).filter(key => key !== ''), ' ']
    return { ort, det, rec, keys }
  })()
  return {
    ready,
    async recognize(imageBytes) {
      const models = await ready
      return recognizeImage(models, decodeJpeg(imageBytes))
    },
  }
}

export function decodeJpeg(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('封面不是 JPEG 图片。')
  const image = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: MAX_IMAGE_PIXELS / 1e6, maxMemoryUsageInMB: 256 })
  if (!image?.width || !image?.height) throw new Error('封面图片无法解码。')
  return image
}

async function recognizeImage({ ort, det, rec, keys }, image) {
  const boxes = await detectText(ort, det, image)
  const lines = []
  for (const box of boxes.slice(0, MAX_BOXES)) {
    const line = await recognizeBox(ort, rec, keys, image, box)
    if (line.text !== '') lines.push({ ...line, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) })
  }
  return { width: image.width, height: image.height, lines }
}

// Nearest-neighbour crop + resize into a 1×3×H×padWidth CHW tensor (BGR).
function toTensor(ort, image, box, outW, outH, padW, normalize) {
  const { width: W, height: H, data } = image
  const tensor = new Float32Array(3 * outH * padW)
  const plane = outH * padW
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(H - 1, Math.floor(box.y + (y + 0.5) * box.h / outH))
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.min(W - 1, Math.floor(box.x + (x + 0.5) * box.w / outW))
      const offset = (sy * W + sx) * 4
      for (let c = 0; c < 3; c += 1) tensor[c * plane + y * padW + x] = normalize(data[offset + 2 - c] / 255, c)
    }
  }
  return new ort.Tensor('float32', tensor, [1, 3, outH, padW])
}

// DB text detection. Screenshot text is horizontal, so axis-aligned boxes of
// the connected components are enough (no rotated rectangles).
async function detectText(ort, det, image) {
  const { width: W, height: H } = image
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(W, H))
  const dW = Math.max(32, Math.round(W * scale / 32) * 32)
  const dH = Math.max(32, Math.round(H * scale / 32) * 32)
  const input = toTensor(ort, image, { x: 0, y: 0, w: W, h: H }, dW, dH, dW, (value, c) => (value - DET_MEAN[c]) / DET_STD[c])
  const output = await det.run({ [det.inputNames[0]]: input })
  const prob = output[det.outputNames[0]].data
  const seen = new Uint8Array(dW * dH)
  const boxes = []
  const stack = []
  for (let start = 0; start < prob.length; start += 1) {
    if (seen[start] || prob[start] <= DET_THRESHOLD) continue
    seen[start] = 1
    stack.push(start)
    let minX = dW, minY = dH, maxX = 0, maxY = 0, count = 0, score = 0
    while (stack.length > 0) {
      const index = stack.pop()
      const x = index % dW
      const y = (index - x) / dW
      count += 1
      score += prob[index]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0) visit(index - 1)
      if (x < dW - 1) visit(index + 1)
      if (y > 0) visit(index - dW)
      if (y < dH - 1) visit(index + dW)
    }
    if (count < DET_MIN_AREA || score / count < DET_BOX_SCORE) continue
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const grow = (w * h * DET_UNCLIP_RATIO) / (2 * (w + h))
    const x0 = Math.max(0, (minX - grow) / dW * W)
    const y0 = Math.max(0, (minY - grow) / dH * H)
    const x1 = Math.min(W, (maxX + 1 + grow) / dW * W)
    const y1 = Math.min(H, (maxY + 1 + grow) / dH * H)
    if (x1 - x0 >= 2 && y1 - y0 >= 2) boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x)

  function visit(index) {
    if (seen[index] || prob[index] <= DET_THRESHOLD) return
    seen[index] = 1
    stack.push(index)
  }
}

// CTC greedy decoding; confidence is the mean probability of kept characters.
async function recognizeBox(ort, rec, keys, image, box) {
  const outW = Math.max(8, Math.min(REC_MAX_WIDTH, Math.round(REC_HEIGHT * box.w / box.h)))
  const input = toTensor(ort, image, box, outW, REC_HEIGHT, outW, value => (value - 0.5) / 0.5)
  const output = (await rec.run({ [rec.inputNames[0]]: input }))[rec.outputNames[0]]
  const [, steps, classes] = output.dims
  let text = ''
  let total = 0
  let kept = 0
  let last = 0
  for (let step = 0; step < steps; step += 1) {
    let best = 0
    let bestProb = -1
    const offset = step * classes
    for (let c = 0; c < classes; c += 1) {
      const p = output.data[offset + c]
      if (p > bestProb) { bestProb = p; best = c }
    }
    if (best !== 0 && best !== last && keys[best] !== undefined) {
      text += keys[best]
      total += bestProb
      kept += 1
    }
    last = best
  }
  return { text: text.trim(), confidence: kept === 0 ? 0 : total / kept }
}
