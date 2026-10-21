import { db } from '../db.js'
import { dogs } from '../repositories/dogs.js'

export class TransferService {
  async transfer(dogId: string, toTeamId: string, byUserId: string) {
    const dog = await dogs.findById(dogId)
    if (!dog) throw new Error('dog not found')
    await dogs.update(dogId, { teamId: toTeamId })
    return db.transfer.create({ data: { dogId, fromTeamId: dog.teamId, toTeamId, byUserId } })
  }
}

export const transfers = new TransferService()
