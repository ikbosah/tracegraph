import { randomBytes } from 'crypto';

const prefixed = (tag: string): string =>
  `${tag}_${randomBytes(8).toString('hex')}`;

export const createRunId     = (): string => prefixed('run');
export const createTraceId   = (): string => prefixed('trace');
export const createEventId   = (): string => prefixed('evt');
export const createSessionId = (): string => prefixed('sess');
export const createBundleId  = (): string => prefixed('bundle');
