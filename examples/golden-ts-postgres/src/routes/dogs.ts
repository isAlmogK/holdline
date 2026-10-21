import { Router } from 'express'
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js'
import { dogs } from '../repositories/dogs.js'
import { transfers } from '../services/transfer.js'

export const dogRoutes = Router()

dogRoutes.get('/dogs', requireAuth, async function listDogs(req, res) {
  res.json(await dogs.list(actorOf(req).teamId))
})

dogRoutes.get('/dogs/:id', requireAuth, async function getDog(req, res) {
  res.json(await dogs.findById(req.params.id))
})

dogRoutes.post('/dogs', requireAuth, requireRole('trainer', 'admin'), async function createDog(req, res) {
  res.status(201).json(await dogs.create({ ...req.body, teamId: actorOf(req).teamId }))
})

dogRoutes.post('/dogs/:id/transfer', requireAuth, requireRole('admin'), async function transferDog(req, res) {
  res.json(await transfers.transfer(req.params.id, req.body.toTeamId, actorOf(req).uid))
})

dogRoutes.delete('/dogs/:id', requireAuth, requireRole('admin'), async function deleteDog(req, res) {
  res.json(await dogs.softDelete(req.params.id))
})
