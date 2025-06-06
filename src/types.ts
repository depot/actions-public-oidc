import {z} from 'zod'
import {Claim} from './durable-objects/Claim'
import {Watcher} from './durable-objects/Watcher'

export const claimSchema = z.object({
  aud: z.string().optional(),
  eventName: z.literal('pull_request'),
  repo: z
    .string()
    .refine((s) => /.+\/.+/.test(s), {message: 'must be in the form owner/repo'})
    .transform((s) => {
      const [owner, repo] = s.split('/')
      return {owner, repo}
    }),
  runID: z
    .string()
    .refine((s) => /^\d+$/.test(s), {message: 'must be a number'})
    .transform((s) => parseInt(s, 10)),
  attempt: z
    .string()
    .refine((s) => /^\d+$/.test(s), {message: 'must be a number'})
    .transform((s) => parseInt(s, 10))
    .optional(),
})

export type ClaimSchema = z.infer<typeof claimSchema>

export interface Env {
  Bindings: {
    KEYS: KVNamespace
    ADMIN_TOKEN: string
    GITHUB_TOKEN: string
    CLAIM: DurableObjectNamespace<Claim>
    WATCHER: DurableObjectNamespace<Watcher>
  }
}

export interface TokenClaims {
  sub: string
  actor_id: string
  actor: string
  event_name: string
  head_ref: string
  head_repository_id: string
  head_repository_owner_id: string
  head_repository_owner: string
  head_repository: string
  head_sha: string
  job_id: string
  repository_id: string
  repository_owner_id: string
  repository_owner: string
  repository_visibility: string
  repository: string
  run_attempt: string
  run_id: string
  run_number: string
  workflow: string
}
