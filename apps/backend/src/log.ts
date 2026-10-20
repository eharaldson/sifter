import pino from 'pino';
import { nanoid } from 'nanoid';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined
});

export function generateRequestId(): string {
  return nanoid(10);
}

export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
