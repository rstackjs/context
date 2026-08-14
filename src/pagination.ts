const encodeCursor = (offset: number): string => Buffer.from(String(offset)).toString('base64url');

const decodeCursor = (cursor: string | undefined, errorMessage: string): number => {
  if (cursor === undefined) return 0;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number(value);
  if (
    !/^(?:0|[1-9]\d*)$/u.test(value) ||
    Buffer.from(value).toString('base64url') !== cursor ||
    !Number.isSafeInteger(offset)
  ) {
    throw new Error(errorMessage);
  }
  return offset;
};

export { decodeCursor, encodeCursor };
