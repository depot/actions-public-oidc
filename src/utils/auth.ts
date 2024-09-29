import {HonoRequest} from 'hono'
import {Env} from '../types'

export async function authenticateAdmin(env: Env['Bindings'], req: HonoRequest<any>) {
  const header = req.header('authorization')
  if (!header) throw new Error('missing authorization header')
  const [type, token] = header.split(' ')
  if (type !== 'Bearer') throw new Error('invalid authorization type')
  if (token !== env.ADMIN_TOKEN) throw new Error('invalid token')
}
