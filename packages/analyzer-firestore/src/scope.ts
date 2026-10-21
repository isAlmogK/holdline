import type { FunctionDecl } from './ast.js'

export interface FunctionDef { decl: FunctionDecl; scope: Scope }

/** Lexical scope of a service block or `match`: its wildcards and the functions declared in it. */
export class Scope {
  readonly functions = new Map<string, FunctionDef>()

  constructor(readonly parent: Scope | undefined, readonly wildcards: ReadonlySet<string>) {}

  findFunction(name: string): FunctionDef | undefined {
    return this.functions.get(name) ?? this.parent?.findFunction(name)
  }

  isWildcard(name: string): boolean {
    return this.wildcards.has(name) || (this.parent?.isWildcard(name) ?? false)
  }
}
