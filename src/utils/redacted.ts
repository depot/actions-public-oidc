/**
 * Holds a credential so it cannot reach logs, JSON, or string interpolation by accident.
 * Read it only where it is sent, with `.value()`.
 */
export class Redacted<T> {
  readonly #value: T

  constructor(value: T) {
    this.#value = value
  }

  value(): T {
    return this.#value
  }

  toJSON() {
    return '[redacted]'
  }

  toString() {
    return '[redacted]'
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return '[redacted]'
  }
}
