import type {HonoRequest} from 'hono'

const ADMIN_TOKEN = process.env.ADMIN_TOKEN

export async function authenticateAdmin(req: HonoRequest<string>) {
  const header = req.header('authorization')
  if (!header) throw new Error('missing authorization header')
  const [type, token] = header.split(' ')
  if (type !== 'Bearer') throw new Error('invalid authorization type')
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not configured')
  if (token !== ADMIN_TOKEN) throw new Error('invalid token')
}
