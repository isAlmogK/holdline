import type { FunctionDecl, Node } from './ast.js'

export interface FunctionDef { decl: FunctionDecl; scope: Scope }

/** Lexical scope of a service block or `match`: its wildcards and the functions declared in it. */
export class Scope {
  readonly functions = new Map<string, FunctionDef>()

  /** `restWildcards` names the `{name=**}` wildcards among `wildcards`: they hold a path, not a string. */
  constructor(readonly parent: Scope | undefined, readonly wildcards: ReadonlySet<string>, readonly restWildcards: ReadonlySet<string> = new Set()) {}

  findFunction(name: string): FunctionDef | undefined {
    return this.functions.get(name) ?? this.parent?.findFunction(name)
  }

  isWildcard(name: string): boolean {
    return this.wildcards.has(name) || (this.parent?.isWildcard(name) ?? false)
  }

  /** True when the nearest wildcard of this name is a rest wildcard. */
  isRestWildcard(name: string): boolean {
    if (this.wildcards.has(name)) return this.restWildcards.has(name)
    return this.parent?.isRestWildcard(name) ?? false
  }
}

/** A function parameter or `let`: its expression, resolved lazily in the env it was written in. */
export interface Binding { node: Node; env: Env }
export interface Env { scope: Scope; bindings: ReadonlyMap<string, Binding>; depth: number }
export const rootEnv = (scope: Scope): Env => ({ scope, bindings: new Map(), depth: 0 })
