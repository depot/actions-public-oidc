import {z} from 'zod/mini'

export const claimSchema = z.object({
  aud: z.optional(z.string()),
  eventName: z.literal('pull_request'),
  repo: z.pipe(
    z.string().check(z.refine((s) => /.+\/.+/.test(s), {error: 'must be in the form owner/repo'})),
    z.transform((s) => {
      const [owner, repo] = s.split('/')
      return {owner, repo}
    }),
  ),
  runID: z.pipe(
    z.string().check(z.refine((s) => /^\d+$/.test(s), {error: 'must be a number'})),
    z.transform((s) => parseInt(s, 10)),
  ),
  attempt: z.pipe(
    z.optional(z.string().check(z.refine((s) => /^\d+$/.test(s), {error: 'must be a number'}))),
    z.transform((s) => (s ? parseInt(s, 10) : undefined)),
  ),
})

export type ClaimSchema = z.infer<typeof claimSchema>

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
