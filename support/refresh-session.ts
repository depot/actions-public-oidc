import {chromium} from 'playwright'

declare global {
  const process: {
    env: {
      ADMIN_TOKEN: string
      USERNAME: string
      PASSWORD: string
      OTP: string
    }
    exit(code: number): void
  }
}

async function main() {
  const browser = await chromium.launch({headless: true})
  const page = await browser.newPage()
  await page.goto('https://github.com/')
  await page.getByRole('link', {name: 'Sign in'}).click()
  await page.getByLabel('Username or email address').click()
  await page.getByLabel('Username or email address').fill(process.env.USERNAME)
  await page.getByLabel('Password').click()
  await page.getByLabel('Password').fill(process.env.PASSWORD)
  await page.getByRole('button', {name: 'Sign in'}).click()
  await page.getByPlaceholder('XXXXXX').click()
  await page.getByPlaceholder('XXXXXX').fill(process.env.OTP)
  await Promise.race([page.getByLabel('Open user account menu').click(), page.getByText('Confirm').click()])
  await page.getByRole('link', {name: 'Your profile'}).click()
  await page.getByRole('link', {name: process.env.USERNAME}).click()
  const cookies = await page.context().cookies()
  const sessionCookie = cookies.find((c) => c.name === 'user_session')

  if (sessionCookie) {
    console.log('Updating GitHub session...')
    await fetch('https://actions-public-oidc.depot.dev/-/github-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
      },
      body: JSON.stringify({session: sessionCookie.value}),
    })
  }

  await page.close()
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
