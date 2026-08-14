const compareStrings = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareStringsDescending = (left: string, right: string): number =>
  compareStrings(right, left);

export { compareStrings, compareStringsDescending };
