type CursorScope = Readonly<Record<string, string | undefined>>;

const encodeScope = (scope: CursorScope): string =>
  JSON.stringify(
    Object.entries(scope)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

const encodeCursor = (offset: number, scope?: CursorScope): string =>
  Buffer.from(
    scope === undefined ? String(offset) : JSON.stringify([1, offset, encodeScope(scope)]),
  ).toString('base64url');

const decodeCursor = (
  cursor: string | undefined,
  errorMessage: string,
  scope?: CursorScope,
): number => {
  if (cursor === undefined) return 0;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(value).toString('base64url') === cursor) {
    if (scope === undefined) {
      const offset = Number(value);
      if (/^(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(offset)) return offset;
    } else {
      try {
        const decoded: unknown = JSON.parse(value);
        if (
          Array.isArray(decoded) &&
          decoded.length === 3 &&
          decoded[0] === 1 &&
          typeof decoded[1] === 'number' &&
          Number.isSafeInteger(decoded[1]) &&
          decoded[1] >= 0 &&
          decoded[2] === encodeScope(scope)
        ) {
          return decoded[1];
        }
      } catch {
        // Fall through to the surface-specific cursor error.
      }
    }
  }
  throw new Error(errorMessage);
};

export { decodeCursor, encodeCursor };
