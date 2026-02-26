/**
 * logger.ts
 *
 * Lightweight logger for the matchmaking server.
 * - In development: full console output
 * - In production:  only warn/error reach stdout (console.log is a no-op)
 *
 * Usage: import log from '@/logger';
 *        log.info('[Queue] User joined');
 *        log.warn('[Auth] Suspicious token');
 *        log.error('[Redis] Connection failed', err);
 */

const IS_PROD = process.env.NODE_ENV === 'production';

const logger = {
    /** Debug/trace messages — silenced in production */
    info: IS_PROD
        ? () => { }
        : (...args: unknown[]) => console.log(...args),

    /** Warnings — always shown */
    warn: (...args: unknown[]) => console.warn(...args),

    /** Errors — always shown */
    error: (...args: unknown[]) => console.error(...args),
};

export default logger;
