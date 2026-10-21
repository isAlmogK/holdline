import { db } from '../db.js'

export class DogRepository {
  list(teamId: string) {
    return db.dog.findMany({ where: { teamId, deletedAt: null } })
  }

  findById(id: string) {
    return db.dog.findFirst({ where: { id, deletedAt: null } })
  }

  create(data: { name: string; teamId: string; ownerId?: string }) {
    return db.dog.create({ data })
  }

  update(id: string, data: { name?: string; teamId?: string }) {
    return db.dog.update({ where: { id }, data })
  }

  softDelete(id: string) {
    return db.dog.update({ where: { id }, data: { deletedAt: new Date() } })
  }
}

export const dogs = new DogRepository()
