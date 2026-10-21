import { db } from '../db.js'

export class TeamRepository {
  list() {
    return db.team.findMany({ where: { deletedAt: null } })
  }

  softDelete(id: string) {
    return db.team.update({ where: { id }, data: { deletedAt: new Date() } })
  }
}

export const teams = new TeamRepository()
