import express from 'express'
import { adminRoutes } from './routes/admin.js'
import { dogRoutes } from './routes/dogs.js'
import { teamRoutes } from './routes/teams.js'

const app = express()
app.use(express.json())
app.use(dogRoutes, teamRoutes, adminRoutes)
app.listen(3000)
