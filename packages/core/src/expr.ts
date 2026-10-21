import { z } from 'zod'

export type Literal = string | number | boolean | null | (string | number)[]
export type Operand = string | { literal: Literal }

export const OPERAND_PATTERN =
  /^(actor\.uid|actor\.role|actor\.claim\.[A-Za-z0-9_.]+|resource\.[A-Za-z0-9_.]+|incoming\.[A-Za-z0-9_.]+|param\.[A-Za-z0-9_]+)$/

export const LiteralSchema = z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()])),
])

export const OperandSchema = z.union([
  z.string().regex(OPERAND_PATTERN, 'operand must be actor.uid, actor.role, actor.claim.*, resource.*, incoming.* or param.*'),
  z.strictObject({ literal: LiteralSchema }),
])

export const COMPARISON_OPS = ['eq', 'ne', 'in', 'lt', 'gt'] as const
export type ComparisonOp = (typeof COMPARISON_OPS)[number]

export type Atom =
  | { op: 'authenticated' }
  | { op: ComparisonOp; left: Operand; right: Operand }
  | { op: 'exists'; doc: string }
  | { op: 'isNull'; operand: Operand }

export const AtomSchema = z.union([
  z.strictObject({ op: z.literal('authenticated') }),
  z.strictObject({ op: z.enum(COMPARISON_OPS), left: OperandSchema, right: OperandSchema }),
  z.strictObject({ op: z.literal('exists'), doc: z.string().min(1) }),
  z.strictObject({ op: z.literal('isNull'), operand: OperandSchema }),
])

export type Expr =
  | { and: Expr[] }
  | { or: Expr[] }
  | { not: Expr }
  | { atom: Atom }
  | { ref: string }
  | { opaque: string }

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(ExprSchema) }),
    z.strictObject({ or: z.array(ExprSchema) }),
    z.strictObject({ not: ExprSchema }),
    z.strictObject({ atom: AtomSchema }),
    z.strictObject({ ref: z.string().min(1) }),
    z.strictObject({ opaque: z.string() }),
  ]),
)

export const TRUE: Expr = { and: [] }
export const FALSE: Expr = { or: [] }
