import { FactsError, ProposalError, RulesFileError } from '@holdline/core'
import { Command, CommanderError } from 'commander'
import { approveCommand, rejectCommand } from './commands/approve.js'
import { checkCommand } from './commands/check.js'
import { explainCommand } from './commands/explain.js'
import { inferCommand } from './commands/infer.js'
import { muteCommand } from './commands/mute.js'
import { proposeCommand } from './commands/propose.js'
import { reviewCommand } from './commands/review.js'
import { scanCommand } from './commands/scan.js'
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

  program.command('scan')
    .description('Run the analyzers and update .holdline/cache/facts.json')
    .action(() => run(() => scanCommand(io))())

  program.command('infer')
    .description('Print the prompt your agent uses to propose rules')
    .option('--prompt', 'print the prompt')
    .option('--area <path>', 'only facts under this path')
    .option('--budget <tokens>', 'prompt size budget in tokens (default 30000)')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .action((opts) => run(() => inferCommand(opts, io))())

  program.command('propose <file>')
    .description('Validate rule proposals (JSON file, or - for stdin) and stage them for review')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .option('--limit <n>', 'keep at most this many proposals (default 25)')
    .action((source: string, opts) => run(() => proposeCommand(source, opts, io))())

  program.command('review')
    .description('Approve or reject staged proposals one by one')
    .action(() => run(() => reviewCommand(io))())

  program.command('approve [keys...]')
    .description('Approve staged proposals (P-1) or re-approve edited rules (R-003)')
    .option('--all', 'approve everything staged')
    .action((keys: string[], opts) => run(() => approveCommand(keys, opts, io))())

  program.command('reject <keys...>')
    .description('Drop staged proposals')
    .action((keys: string[]) => run(() => rejectCommand(keys, io))())

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
