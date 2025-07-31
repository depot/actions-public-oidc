import * as Sentry from '@sentry/node'
import {chromium} from 'playwright'

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      ADMIN_TOKEN: string
      USERNAME: string
      PASSWORD: string
      OTP: string
      LOCAL?: string
    }
  }
}

async function main() {
  console.log('Starting refresh session...')
  Sentry.init({dsn: process.env.SENTRY_DSN})

  const checkInId = Sentry.captureCheckIn(
    {monitorSlug: 'actions-public-oidc-refresh-session', status: 'in_progress'},
    {
      schedule: {type: 'crontab', value: '23 1 * * *'},
      checkinMargin: 120, // 120 minutes
      maxRuntime: 60, // 60 minutes
      timezone: 'Etc/UTC',
    },
  )

  try {
    await run()
    Sentry.captureCheckIn({checkInId, monitorSlug: 'actions-public-oidc-refresh-session', status: 'ok'})
  } catch (err) {
    Sentry.captureException(err)
    Sentry.captureCheckIn({checkInId, monitorSlug: 'actions-public-oidc-refresh-session', status: 'error'})
    throw err
  }
}

async function run() {
  const browser = await chromium.launch({headless: !Boolean(process.env.LOCAL)})
  const page = await browser.newPage()

  try {
    await page.goto('https://github.com/')
    await page.getByRole('link', {name: 'Sign in'}).click()
    await page.getByLabel('Username or email address').click()
    await page.getByLabel('Username or email address').fill(process.env.USERNAME)
    await page.getByLabel('Password').click()
    await page.getByLabel('Password').fill(process.env.PASSWORD)
    await page.getByRole('button', {name: 'Sign in', exact: true}).click()
    await page.getByPlaceholder('XXXXXX').click()
    await page.getByPlaceholder('XXXXXX').fill(process.env.OTP)
    await Promise.race([
      page.getByLabel('Open user account menu').click(),
      page.getByLabel('Open user navigation menu').click(),
      page.getByRole('button', {name: 'Confirm'}).click(),
    ])
    await Promise.race([
      await page.getByTitle(process.env.USERNAME).click(),
      page.getByLabel('Open user account menu').click(),
      page.getByLabel('Open user navigation menu').click(),
    ])
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === 'user_session')

    if (!sessionCookie) throw new Error('no session cookie')

    await page.screenshot({path: 'tmp/screenshot.png'})

    if (process.env.LOCAL) {
      console.log(sessionCookie)
    }

    if (process.env.ADMIN_TOKEN) {
      console.log('Updating GitHub session...')
      await fetch('https://actions-public-oidc.depot.dev/-/github-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({session: sessionCookie.value}),
      })
    } else {
      throw new Error('no ADMIN_TOKEN')
    }
  } finally {
    await page.close()
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
