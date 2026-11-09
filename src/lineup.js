// Turn video text and cover OCR lines into a list of operators.
//
// Names are only ever taken from the operator list the caller passes in (MAA's
// battle_data.json): nothing is guessed from general knowledge. Every result
// records where it came from and how sure the match is.

export const CERTAINTY = Object.freeze({ certain: 3, likely: 2, guess: 1 })

// Well-known nicknames. An alias is used only when its target is in the
// caller's operator list, so a renamed or unknown operator is simply skipped.
export const DEFAULT_ALIASES = Object.freeze({
  42: '史尔特尔',
  浊心: '浊心斯卡蒂',
  小羊: '艾雅法拉',
  银老板: '银灰',
})

const SEPARATOR = '[\\s+＋、，,/|｜&（）()【】\\[\\]·:：;；~～-]'
const SQUAD_MARKERS = ['快捷编队', '开始行动', '助战干员', '编队']
const MAA_CODE = /maa:\/\/(\d{1,12})/giu

export function createNameIndex(operatorNames, aliases = DEFAULT_ALIASES) {
  const names = new Set()
  for (const raw of operatorNames ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name !== '') names.add(name)
  }
  const terms = new Map()
  for (const name of names) terms.set(name, name)
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (names.has(target) && !terms.has(alias) && String(alias).length >= 2) terms.set(String(alias), target)
  }
  // Longest first, so 浊心斯卡蒂 claims its characters before 斯卡蒂 can.
  const ordered = [...terms.keys()].sort((a, b) => b.length - a.length)
  return { names, terms, ordered }
}

/** Operators mentioned in free text (title, description, tags, comments). */
export function findOperatorsInText(text, index) {
  const source = String(text ?? '')
  if (source === '') return []
  const taken = new Uint8Array(source.length)
  const found = new Map()
  for (const term of index.ordered) {
    for (const start of occurrences(source, term)) {
      const end = start + term.length
      if (taken.subarray(start, end).some(Boolean)) continue
      if (!standsAlone(source, start, end, term)) continue
      taken.fill(1, start, end)
      const name = index.terms.get(term)
      if (!found.has(name)) found.set(name, { name, term })
    }
  }
  return [...found.values()]
}

function occurrences(source, term) {
  const positions = []
  let from = 0
  while (true) {
    const at = source.indexOf(term, from)
    if (at < 0) return positions
    positions.push(at)
    from = at + 1
  }
}

// One-character names (年, 夕, 令 ...) and Latin names only count as whole
// tokens; inside ordinary text they are almost always something else.
function standsAlone(source, start, end, term) {
  const latin = /^[\x20-\x7e]+$/u.test(term)
  if (term.length >= 2 && !latin) return true
  const before = start === 0 ? '' : source[start - 1]
  const after = end >= source.length ? '' : source[end]
  if (latin) return !/[A-Za-z0-9]/u.test(before) && !/[A-Za-z0-9]/u.test(after)
  const separator = new RegExp(`^(?:${SEPARATOR})?$`, 'u')
  return separator.test(before) && separator.test(after)
}

export function extractMaaCodes(...texts) {
  const codes = new Set()
  for (const text of texts) for (const match of String(text ?? '').matchAll(MAA_CODE)) codes.add(match[1])
  return [...codes]
}

/** Classify the cover and drop OCR lines that cannot name a squad member. */
export function analyzeCoverLines(lines, index) {
  const usable = (lines ?? []).filter(line => typeof line?.text === 'string' && normalize(line.text).length >= 1)
  const joined = usable.map(line => normalize(line.text)).join('')
  const squad = SQUAD_MARKERS.some(marker => joined.includes(marker)) || (joined.includes('开始') && joined.includes('行动'))
  const dropped = new Set()
  if (squad) {
    // The squad tabs are one row of 3+ labels, mostly not operator names
    // (e.g. 凯尔希 | 想想办法 | 我要死了 | 岁海队). A tab named after an
    // operator must not be counted as a squad member.
    for (const row of groupRows(usable.filter(line => normalize(line.text).length >= 2))) {
      if (row.length < 3) continue
      const named = row.filter(line => matchLine(line, index) !== null).length
      if (named * 2 < row.length) for (const line of row) dropped.add(line)
    }
  }
  const operators = new Map()
  const ignored = []
  for (const line of usable) {
    if (dropped.has(line)) { ignored.push({ text: line.text, reason: 'squad-tab' }); continue }
    const match = matchLine(line, index)
    if (match === null) continue
    for (const item of match) {
      const previous = operators.get(item.name)
      if (previous === undefined || CERTAINTY[item.certainty] > CERTAINTY[previous.certainty]) operators.set(item.name, item)
    }
  }
  return { layout: squad ? 'squad' : 'unknown', operators: [...operators.values()], ignored }
}

function groupRows(lines) {
  const rows = []
  for (const line of [...lines].sort((a, b) => centerY(a) - centerY(b))) {
    const row = rows.at(-1)
    if (row && Math.abs(centerY(row[0]) - centerY(line)) <= Math.max(4, Math.min(row[0].h ?? 0, line.h ?? 0) / 2)) row.push(line)
    else rows.push([line])
  }
  return rows
}

function centerY(line) { return (line.y ?? 0) + (line.h ?? 0) / 2 }

function normalize(text) {
  return String(text).replace(/[\s·.。,，、'"`]/gu, '')
}

// A whole line equal to a name is the strongest evidence; a name inside a
// longer line ("维什戴尔+冻河 低配") is likely; one wrong character is a guess.
function matchLine(line, index) {
  const text = normalize(line.text)
  const confidence = Number(line.confidence ?? line.conf ?? 0)
  const exact = index.terms.get(text)
  if (exact !== undefined) {
    return [{ name: exact, text: line.text, confidence, certainty: confidence >= 0.8 ? 'certain' : 'likely' }]
  }
  const inside = findOperatorsInText(line.text, index)
  if (inside.length > 0) return inside.map(item => ({ name: item.name, text: line.text, confidence, certainty: 'likely' }))
  if (text.length >= 3 && confidence >= 0.5) {
    const near = [...index.names].filter(name => Math.abs(name.length - text.length) <= 1 && editDistance(name, text) === 1)
    if (near.length === 1) return [{ name: near[0], text: line.text, confidence, certainty: 'guess' }]
  }
  return null
}

export function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const kept = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = kept
    }
  }
  return previous[b.length]
}

/** Merge per-source findings into one list, strongest certainty first. */
export function mergeLineup(entries) {
  const merged = new Map()
  for (const { source, operators } of entries) {
    for (const item of operators) {
      const certainty = item.certainty ?? 'likely'
      const current = merged.get(item.name)
      if (current === undefined) {
        merged.set(item.name, { name: item.name, certainty, sources: [source] })
        continue
      }
      if (!current.sources.includes(source)) current.sources.push(source)
      if (CERTAINTY[certainty] > CERTAINTY[current.certainty]) current.certainty = certainty
    }
  }
  // A weaker mention that is part of a stronger, longer name is a short form
  // of it (comments write 初雪 for 圣聆初雪): fold it in instead of listing a
  // second operator.
  for (const short of [...merged.values()]) {
    const full = [...merged.values()].find(item => item !== short && item.name.length > short.name.length
      && item.name.includes(short.name) && CERTAINTY[item.certainty] > CERTAINTY[short.certainty])
    if (full === undefined) continue
    for (const source of short.sources) if (!full.sources.includes(source)) full.sources.push(source)
    merged.delete(short.name)
  }
  return [...merged.values()].sort((a, b) => CERTAINTY[b.certainty] - CERTAINTY[a.certainty])
}
