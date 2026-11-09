// Runs the real MAA models on a real cover. Opt-in, because neither the
// models nor a third-party cover image are part of this repository:
//   COVEROCR_RESOURCE_DIR=<MAA resource dir> COVEROCR_SAMPLE=<cover.jpg>
//   COVEROCR_EXPECT=维什戴尔,结城理  (optional)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createOcrEngine } from '../src/ocr.js'
import { analyzeCoverLines, createNameIndex } from '../src/lineup.js'

const resourceDir = process.env.COVEROCR_RESOURCE_DIR
const sample = process.env.COVEROCR_SAMPLE

test('real MAA OCR models read a real cover', { skip: !resourceDir || !sample ? 'set COVEROCR_RESOURCE_DIR and COVEROCR_SAMPLE' : false }, async () => {
  const engine = createOcrEngine(resourceDir)
  const started = performance.now()
  await engine.ready
  const loaded = performance.now()
  const result = await engine.recognize(await readFile(sample))
  const done = performance.now()
  const battle = JSON.parse(await readFile(path.join(resourceDir, 'battle_data.json'), 'utf8'))
  const names = Object.values(battle.chars).map(entry => entry?.name).filter(name => typeof name === 'string')
  const analysis = analyzeCoverLines(result.lines, createNameIndex(names))
  console.log(`load ${(loaded - started).toFixed(0)} ms, recognize ${(done - loaded).toFixed(0)} ms, ${result.lines.length} lines, layout ${analysis.layout}`)
  console.log(analysis.operators.map(item => `${item.name}(${item.certainty})`).join(' '))
  const expected = (process.env.COVEROCR_EXPECT ?? '').split(',').filter(Boolean)
  for (const name of expected) assert.ok(analysis.operators.some(item => item.name === name), `expected ${name}`)
})
