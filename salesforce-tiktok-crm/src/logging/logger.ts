import pino from 'pino';
import { env } from '../config/env';

const transport =
  env.NODE_ENV !== 'production'
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined;

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: {
      service: 'salesforce-tiktok-crm',
      version: env.INTEGRATION_VERSION,
      env: env.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    redact: {
      // Never log raw PII — only hashed values reach our logs
      paths: [
        'payload.email',
        'payload.phone',
        'payload.first_name',
        'payload.last_name',
        'user.email',
        'user.phone',
        '*.Email',
        '*.Phone',
        '*.FirstName',
        '*.LastName',
      ],
      censor: '[REDACTED]',
    },
  },
  transport,
);

export type Logger = typeof logger;
