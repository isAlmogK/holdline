import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { users } from '../repositories/users.js'

export const adminRoutes = Router()

adminRoutes.get('/admin/users', requireAuth, requireRole('admin'), async function listUsers(_req, res) {
  res.json(await users.list())
})
