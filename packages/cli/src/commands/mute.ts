import { mute } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadRules, saveRules, today } from '../workspace.js'

export async function muteCommand(id: string, opts: { reason?: string }, io: Io): Promise<number> {
  if (!opts.reason) throw new UsageError('mute needs --reason "<why>"')
  const file = await loadRules(io.cwd)
  if (!file.rules.some(r => r.id === id)) throw new UsageError(`no rule ${id}`)
  await saveRules(io.cwd, mute(file, id, { by: approver(io), at: today(io), reason: opts.reason }))
  io.stdout(`Muted ${id}: ${opts.reason}\n`)
  return 0
}
