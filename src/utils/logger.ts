type Severity = 'DEFAULT' | 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'ALERT' | 'EMERGENCY'

const levels: Record<Severity | 'WARN', number> = {
  DEFAULT: 0,
  DEBUG: 100,
  INFO: 200,
  NOTICE: 300,
  WARN: 400,
  WARNING: 400,
  ERROR: 500,
  CRITICAL: 600,
  ALERT: 700,
  EMERGENCY: 800,
}
const LOG_LEVEL = levels[(process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as Severity] ?? levels.INFO

/** Basic JSON logger */
class Logger {
  /** Log with no assigned severity level */
  default(message: string, context: object = {}) {
    this.log('DEFAULT', message, context)
  }

  /** Log debug or trace information */
  debug(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.DEBUG) return
    this.log('DEBUG', message, context)
  }

  /** Log routine information, such as ongoing status or performance */
  info(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.INFO) return
    this.log('INFO', message, context)
  }

  /** Log normal but significant events, such as start up, shut down, or a configuration change */
  notice(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.NOTICE) return
    this.log('NOTICE', message, context)
  }

  /** Log warning events that might cause problems */
  warning(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.WARNING) return
    this.log('WARNING', message, context)
  }

  /** Log error events that are likely to cause problems */
  error(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.ERROR) return
    this.log('ERROR', message, context)
  }

  /** Log critical events that cause more severe problems or outages */
  critical(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.CRITICAL) return
    this.log('CRITICAL', message, context)
  }

  /** Log events where a person must take an action immediately */
  alert(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.ALERT) return
    this.log('ALERT', message, context)
  }

  /** Log events that render one or more systems unusable */
  emergency(message: string, context: object = {}) {
    if (LOG_LEVEL > levels.EMERGENCY) return
    this.log('EMERGENCY', message, context)
  }

  private log(severity: Severity, message: string, context: object = {}) {
    const time = new Date().toISOString()
    console.log(JSON.stringify({time, severity, message, ...context}))
  }
}

export const logger = new Logger()
