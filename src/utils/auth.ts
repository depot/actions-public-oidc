import type {HonoRequest} from 'hono'
import {HTTPException} from 'hono/http-exception'

const ADMIN_TOKEN = process.env.ADMIN_TOKEN

export async function authenticateAdmin(req: HonoRequest<string>) {
  const header = req.header('authorization')
  if (!header) throw new HTTPException(401, {message: 'missing authorization header'})
  const [type, token] = header.split(' ')
  if (type !== 'Bearer') throw new HTTPException(401, {message: 'invalid authorization type'})
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not configured')
  if (token !== ADMIN_TOKEN) throw new HTTPException(401, {message: 'invalid token'})
}
