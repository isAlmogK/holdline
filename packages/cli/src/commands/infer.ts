import { buildInferPrompt } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'

export async function inferCommand(opts: { prompt?: boolean; area?: string; budget?: string; facts?: string }, io: Io): Promise<number> {
  if (!opts.prompt) throw new UsageError('holdline infer only prints a prompt for your agent: run `holdline infer --prompt`')
  const budget = opts.budget ? Number(opts.budget) : undefined
  if (budget !== undefined && !(budget > 0)) throw new UsageError('--budget must be a positive number of tokens')
  const facts = await loadFacts(io.cwd, opts.facts)
  let prompt: string
  try {
    prompt = buildInferPrompt(facts, await loadRules(io.cwd), { area: opts.area, budgetTokens: budget })
  } catch (e) {
    if (e instanceof Error && e.message.includes('raise --budget')) throw new UsageError(e.message)
    throw e
  }
  io.stdout(`${prompt}\n`)
  return 0
}
