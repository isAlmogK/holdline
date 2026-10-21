import { FactsError, ProposalError, RulesFileError } from '@holdline/core'
import { Command, CommanderError } from 'commander'
import { checkCommand } from './commands/check.js'
import { explainCommand } from './commands/explain.js'
import { muteCommand } from './commands/mute.js'
import { UsageError, type Io } from './io.js'

export type { Io } from './io.js'

export async function main(argv: string[], io: Io): Promise<number> {
  let code = 0
  const program = new Command('holdline')
    .description('Find, approve and enforce the business rules in your codebase')
    .exitOverride()
    .configureOutput({ writeOut: t => io.stdout(t), writeErr: t => io.stderr(t) })
    .showHelpAfterError()

  const run = (fn: () => Promise<number>) => async () => { code = await fn() }

  program.command('check')
    .description('Check approved rules against the code')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .option('--format <format>', 'human, agent or json', 'human')
    .option('--strict', 'also fail on stale or unknown rules')
    .option('--rule <ids...>', 'only these rules')
    .action((opts) => run(() => checkCommand(opts, io))())

  program.command('explain <id>')
    .description('Show a rule, its evidence and its current status')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .action((id: string, opts) => run(() => explainCommand(id, opts, io))())

  program.command('mute <id>')
    .description('Turn a rule off, recording why')
    .option('--reason <reason>', 'why the rule is muted')
    .action((id: string, opts) => run(() => muteCommand(id, opts, io))())

  try {
    await program.parseAsync(argv, { from: 'user' })
    return code
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2
    if (e instanceof UsageError || e instanceof RulesFileError || e instanceof FactsError || e instanceof ProposalError) {
      io.stderr(`holdline: ${e.message}\n`)
      return 2
    }
    io.stderr(`holdline: internal error: ${(e as Error).stack ?? String(e)}\n`)
    return 3
  }
}
