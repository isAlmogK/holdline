import { db } from '../db.js'

export class UserRepository {
  list() {
    return db.user.findMany()
  }
}

export const users = new UserRepository()
