import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCoverLines, createNameIndex, editDistance, extractMaaCodes, findOperatorsInText, mergeLineup } from '../src/lineup.js'

const NAMES = ['维什戴尔', '结城理', '白面鸮', '冻河', '圣聆初雪', '凯尔希', '斯卡蒂', '浊心斯卡蒂', '史尔特尔', '年', '夕', 'Lin', '艾雅法拉', '银灰']
const index = createNameIndex(NAMES)

test('finds operator names in free text, longest name first', () => {
  const found = findOperatorsInText('浊心斯卡蒂+维什戴尔 低配，冻河辅助', index).map(item => item.name)
  assert.deepEqual(found.sort(), ['冻河', '维什戴尔', '浊心斯卡蒂'].sort())
  assert.ok(!found.includes('斯卡蒂'), 'a shorter name inside a longer match is not counted again')
})

test('one-character and Latin names only count as separate tokens', () => {
  assert.deepEqual(findOperatorsInText('年+夕 双人', index).map(item => item.name).sort(), ['夕', '年'])
  assert.deepEqual(findOperatorsInText('新年快乐，夕阳西下', index), [])
  assert.deepEqual(findOperatorsInText('Lin solo', index).map(item => item.name), ['Lin'])
  assert.deepEqual(findOperatorsInText('Linear', index), [])
})

test('aliases resolve only to operators in the provided list', () => {
  assert.deepEqual(findOperatorsInText('42 单核 浊心', index).map(item => item.name).sort(), ['史尔特尔', '浊心斯卡蒂'].sort())
  assert.deepEqual(findOperatorsInText('4200 分', index), [])
  const small = createNameIndex(['冻河'])
  assert.deepEqual(findOperatorsInText('42 单核', small), [], 'alias target missing from the list is skipped')
})

test('extracts maa:// codes', () => {
  assert.deepEqual(extractMaaCodes('作业 maa://12345', '置顶：MAA://678 和 maa://12345'), ['12345', '678'])
})

// Recognized lines from the real TL-EX-8 squad cover (prototype run).
const SQUAD_LINES = [
  { text: '快捷编队', confidence: 1, x: 618, y: 89, w: 70, h: 18 },
  { text: 'o', confidence: 0.6, x: 275, y: 258, w: 8, h: 10 },
  { text: 'e战于', confidence: 0.7, x: 620, y: 279, w: 40, h: 14 },
  { text: '维什戴尔', confidence: 0.882, x: 124, y: 281, w: 46, h: 14 },
  { text: '结城理', confidence: 0.998, x: 220, y: 281, w: 36, h: 14 },
  { text: '白面鸮', confidence: 1, x: 308, y: 281, w: 36, h: 14 },
  { text: '开始', confidence: 1, x: 631, y: 352, w: 40, h: 22 },
  { text: '行动', confidence: 0.979, x: 630, y: 380, w: 40, h: 22 },
  { text: '圣聆初雪', confidence: 0.935, x: 212, y: 443, w: 46, h: 14 },
  { text: '冻河', confidence: 1, x: 147, y: 444, w: 24, h: 14 },
  { text: '岁海队', confidence: 1, x: 606, y: 500, w: 40, h: 16 },
  { text: '凯尔希', confidence: 1, x: 128, y: 502, w: 40, h: 16 },
  { text: '想想办法', confidence: 1, x: 294, y: 502, w: 56, h: 16 },
  { text: '我要死了', confidence: 1, x: 447, y: 503, w: 56, h: 16 },
]

test('a squad-screen cover yields its members and drops the squad tab row', () => {
  const result = analyzeCoverLines(SQUAD_LINES, index)
  assert.equal(result.layout, 'squad')
  assert.deepEqual(result.operators.map(item => item.name).sort(), ['冻河', '圣聆初雪', '白面鸮', '结城理', '维什戴尔'].sort())
  assert.ok(result.operators.every(item => item.certainty === 'certain'))
  assert.ok(result.ignored.some(item => item.text === '凯尔希' && item.reason === 'squad-tab'))
})

test('a non-squad cover keeps every line and grades fuzzy matches as guesses', () => {
  const result = analyzeCoverLines([
    { text: '维什戴尔+冻河 低配', confidence: 0.95, x: 0, y: 0, w: 200, h: 30 },
    { text: '圣聆初雷', confidence: 0.9, x: 0, y: 50, w: 80, h: 30 },
    { text: '凯尔希', confidence: 0.6, x: 0, y: 100, w: 60, h: 30 },
  ], index)
  assert.equal(result.layout, 'unknown')
  const byName = Object.fromEntries(result.operators.map(item => [item.name, item.certainty]))
  assert.deepEqual(byName, { 维什戴尔: 'likely', 冻河: 'likely', 圣聆初雪: 'guess', 凯尔希: 'likely' })
})

test('merging keeps the strongest certainty and every source', () => {
  const merged = mergeLineup([
    { source: 'cover', operators: [{ name: '冻河', certainty: 'certain' }] },
    { source: 'title', operators: [{ name: '冻河', certainty: 'likely' }, { name: '年', certainty: 'likely' }] },
  ])
  assert.deepEqual(merged, [
    { name: '冻河', certainty: 'certain', sources: ['cover', 'title'] },
    { name: '年', certainty: 'likely', sources: ['title'] },
  ])
})

test('a weaker short form of a stronger full name is folded into it', () => {
  const merged = mergeLineup([
    { source: 'cover', operators: [{ name: '圣聆初雪', certainty: 'certain' }] },
    { source: 'comments', operators: [{ name: '初雪', certainty: 'likely' }, { name: '冻河', certainty: 'likely' }] },
  ])
  assert.deepEqual(merged, [
    { name: '圣聆初雪', certainty: 'certain', sources: ['cover', 'comments'] },
    { name: '冻河', certainty: 'likely', sources: ['comments'] },
  ])
  const alone = mergeLineup([{ source: 'title', operators: [{ name: '初雪', certainty: 'likely' }] }])
  assert.deepEqual(alone.map(item => item.name), ['初雪'], 'without a stronger full name it stays')
})

test('edit distance', () => {
  assert.equal(editDistance('圣聆初雪', '圣聆初雷'), 1)
  assert.equal(editDistance('abc', 'abc'), 0)
  assert.equal(editDistance('', 'ab'), 2)
})
