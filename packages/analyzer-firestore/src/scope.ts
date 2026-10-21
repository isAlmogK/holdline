import type { Block, FunctionDecl, Node, RulesAst } from './ast.js'

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
/**
 * Where an expression is read. `active` holds the functions being inlined around it (Firestore forbids
 * recursion); `budget` is shared by every env derived from one `rootEnv`, i.e. one normalized condition.
 */
export interface Env {
  scope: Scope
  bindings: ReadonlyMap<string, Binding>
  depth: number
  active: ReadonlySet<FunctionDef>
  budget: { inlines: number; bindings: number }
}

/** How many function inlines one condition may make; past it, further calls are opaque. */
export const MAX_INLINES_PER_CONDITION = 1000

/**
 * How many param or let references one condition may resolve. Each reference re-reads its bound expression,
 * so `let a1 = a0 && a0; let a2 = a1 && a1; …` doubles per let; past it, a reference is opaque.
 */
export const MAX_BINDING_RESOLUTIONS_PER_CONDITION = 10000

/** A fresh env for one condition: call it once per normalized condition. */
export const rootEnv = (scope: Scope): Env => ({
  scope, bindings: new Map(), depth: 0, active: new Set(),
  budget: { inlines: MAX_INLINES_PER_CONDITION, bindings: MAX_BINDING_RESOLUTIONS_PER_CONDITION },
})

/** Declarations per function name across the whole file, at every level. */
export function countFunctions(ast: RulesAst): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (block: Block): void => {
    for (const fn of block.functions) counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1)
    for (const m of block.matches) visit(m.body)
  }
  for (const svc of ast.services) visit(svc.body)
  return counts
}
