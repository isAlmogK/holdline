import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { teams } from '../repositories/teams.js'

export const teamRoutes = Router()

teamRoutes.get('/teams', requireAuth, async function listTeams(_req, res) {
  res.json(await teams.list())
})

teamRoutes.delete('/teams/:id', requireAuth, requireRole('admin'), async function deleteTeam(req, res) {
  res.json(await teams.softDelete(req.params.id))
})
