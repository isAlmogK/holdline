import { ParseError, type MatchSegment, type Node, type PathPart } from './ast.js'
import type { Lexer } from './lexer.js'

const SEGMENT_CHAR = /[A-Za-z0-9_\-.~%@+:]/
const WILDCARD = /\{([A-Za-z0-9_]+)(=\*\*)?\}/y

/** What path reading needs from the expression parser: the lexer and `$(…)` interpolation. */
export interface PathHost {
  readonly lexer: Lexer
  /** Parses `expr )` starting just after a `$(` at `from`; returns the expression and the offset after `)`. */
  parseInterpolation(from: number): { expr: Node; end: number }
}

type Reader<T> = (from: number) => { value: T; end: number } | undefined

/** Reads `/seg/seg…` from the source at the `/` at `start` and leaves the lexer just after it. */
function readPath<T>(host: PathHost, start: number, readOne: Reader<T>): { items: T[]; end: number } {
  const src = host.lexer.src
  const items: T[] = []
  let i = start
  while (src[i] === '/') {
    const one = readOne(i + 1)
    if (!one) break
    items.push(one.value)
    i = one.end
  }
  if (items.length === 0) {
    const { line, col } = host.lexer.position(start)
    throw new ParseError(line, col, "expected a path segment after '/'")
  }
  host.lexer.seek(i)
  return { items, end: i }
}

/** Expression path literal: every segment is a list of text and `$(…)` parts. */
export function readExprPath(host: PathHost, start: number): { segments: PathPart[][]; end: number } {
  const { items, end } = readPath(host, start, from => {
    const seg = readSegment(host, from)
    return seg && { value: seg.parts, end: seg.end }
  })
  return { segments: items, end }
}

/** Match path: segments are literals, `{name}` / `{name=**}` wildcards, or segments holding `$(…)`. */
export function readMatchPath(host: PathHost, start: number): { segments: MatchSegment[]; end: number } {
  const src = host.lexer.src
  const { items, end } = readPath<MatchSegment>(host, start, from => {
    if (src[from] === '{') {
      WILDCARD.lastIndex = from
      const m = WILDCARD.exec(src)
      if (!m) {
        const { line, col } = host.lexer.position(from)
        throw new ParseError(line, col, 'invalid wildcard (expected {name} or {name=**})')
      }
      return { value: { kind: 'wildcard', name: m[1]!, rest: m[2] !== undefined }, end: from + m[0].length }
    }
    const seg = readSegment(host, from)
    if (!seg) return undefined
    const only = seg.parts.length === 1 ? seg.parts[0]! : undefined
    const value: MatchSegment = only?.kind === 'text' ? { kind: 'literal', value: only.value } : { kind: 'interp', parts: seg.parts }
    return { value, end: seg.end }
  })
  return { segments: items, end }
}

function readSegment(host: PathHost, from: number): { parts: PathPart[]; end: number } | undefined {
  const src = host.lexer.src
  const parts: PathPart[] = []
  const addText = (value: string) => {
    const last = parts[parts.length - 1]
    if (last?.kind === 'text') last.value += value
    else parts.push({ kind: 'text', value })
  }
  let i = from
  for (;;) {
    const c = src[i]
    if (c === '$' && src[i + 1] === '(') {
      const { expr, end } = host.parseInterpolation(i + 2)
      parts.push({ kind: 'interp', expr })
      i = end
    } else if (c === '(') {
      let depth = 0
      let j = i
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++
        else if (src[j] === ')' && --depth === 0) break
      }
      if (j >= src.length) {
        const { line, col } = host.lexer.position(i)
        throw new ParseError(line, col, "unterminated '(' in path")
      }
      addText(src.slice(i, j + 1))
      i = j + 1
    } else if (c !== undefined && SEGMENT_CHAR.test(c)) {
      let j = i + 1
      while (j < src.length && SEGMENT_CHAR.test(src[j]!)) j++
      addText(src.slice(i, j))
      i = j
    } else break
  }
  return parts.length === 0 ? undefined : { parts, end: i }
}
