export interface IgnoreMatcher {
  matches(filePath: string): boolean;
  addPattern(pattern: string): void;
  addPatterns(patterns: string[]): void;
}

export function createIgnoreMatcher(patterns?: string[]): IgnoreMatcher {
  throw new Error('Not implemented');
}

export function matchesPattern(pattern: string, filePath: string): boolean {
  throw new Error('Not implemented');
}
