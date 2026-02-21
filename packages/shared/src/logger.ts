import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  name: 'realtimecode',
  level: config.logLevel
});
