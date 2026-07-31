export interface IgnoreMatcher {
  matches(filePath: string): boolean;
  addPattern(pattern: string): void;
  addPatterns(patterns: string[]): void;
}

interface CompiledPattern {
  negated: boolean;
  regex: RegExp;
  dirOnly: boolean;
}

function hasGlobChars(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' || p[i] === '?' || p[i] === '[') {
      return true;
    }
  }
  return false;
}

function compilePattern(pattern: string): CompiledPattern {
  let p = pattern;
  let negated = false;

  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }

  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }

  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }

  // Literal patterns (no glob chars) without a trailing / are exact filename matches
  if (!hasGlobChars(p) && !dirOnly) {
    anchored = true;
  }

  // Convert glob to regex
  let regexStr = '';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    switch (ch) {
      case '*':
        if (p[i + 1] === '*') {
          // ** can cross directory boundaries
          i += 2;
          if (p[i] === '/') {
            i++; // **/ matches any number of directories
          }
          regexStr += '.*';
        } else {
          regexStr += '[^/]*';
          i++;
        }
        break;
      case '?':
        regexStr += '[^/]';
        i++;
        break;
      case '[':
        // Segment wildcard: [name] matches any path segment (like Next.js dynamic routes)
        regexStr += '[^/]+';
        i++;
        while (i < p.length && p[i] !== ']') {
          i++;
        }
        if (i < p.length) {
          i++; // skip closing ]
        }
        break;
      case '.':
      case '(':
      case ')':
      case '+':
      case '^':
      case '$':
      case '{':
      case '}':
      case '|':
      case '\\':
        regexStr += '\\' + ch;
        i++;
        break;
      default:
        regexStr += ch;
        i++;
    }
  }

  if (anchored) {
    regexStr = '^' + regexStr;
  } else {
    regexStr = '(^|/)' + regexStr;
  }

  if (dirOnly) {
    regexStr += '(/|$)';
  } else {
    regexStr += '(/|$)';
  }

  return {
    negated,
    regex: new RegExp(regexStr),
    dirOnly,
  };
}

export function createIgnoreMatcher(patterns?: string[]): IgnoreMatcher {
  const compiled: CompiledPattern[] = [];

  const matcher: IgnoreMatcher = {
    matches(filePath: string): boolean {
      // Strip leading / to normalize absolute paths for pattern matching
      const normalized = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      let ignored = false;
      for (const cp of compiled) {
        if (cp.regex.test(normalized)) {
          ignored = !cp.negated;
        }
      }
      return ignored;
    },

    addPattern(pattern: string): void {
      compiled.push(compilePattern(pattern));
    },

    addPatterns(patterns: string[]): void {
      for (const p of patterns) {
        compiled.push(compilePattern(p));
      }
    },
  };

  if (patterns) {
    matcher.addPatterns(patterns);
  }

  return matcher;
}

export function matchesPattern(pattern: string, filePath: string): boolean {
  const cp = compilePattern(pattern);
  const matches = cp.regex.test(filePath);
  return cp.negated ? !matches : matches;
}
