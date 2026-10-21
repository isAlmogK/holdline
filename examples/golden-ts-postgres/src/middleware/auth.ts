import type { NextFunction, Request, Response } from 'express'

export type Actor = { uid: string; role: 'admin' | 'trainer' | 'member'; teamId: string }

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const actor = (req as Request & { actor?: Actor }).actor
  if (!actor) return res.status(401).json({ error: 'sign in required' })
  next()
}

export function requireRole(...roles: Actor['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as Request & { actor?: Actor }).actor
    if (!actor || !roles.includes(actor.role)) return res.status(403).json({ error: 'forbidden' })
    next()
  }
}

export const actorOf = (req: Request) => (req as Request & { actor: Actor }).actor
