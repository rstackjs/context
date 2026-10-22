import { createHash } from 'node:crypto';

const sha256Pattern: RegExp = /^[0-9a-f]{64}$/u;

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const sha256Hex = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

export {
  getNonEmptyString,
  isIdentifier,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecordObject,
  sha256Hex,
  sha256Pattern,
};
