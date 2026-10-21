/** Source position. 1-based line/col; start/end are source offsets, end exclusive. */
export interface Pos { line: number; col: number; start: number; end: number }

export class ParseError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) {
    super(message)
    this.name = 'ParseError'
  }
}
