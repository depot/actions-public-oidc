interface RetryOptions {
  retries?: number
  delay?: number
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}) {
  const {retries = 3, delay = 1000} = options

  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= retries - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw new Error('unreachable')
}
