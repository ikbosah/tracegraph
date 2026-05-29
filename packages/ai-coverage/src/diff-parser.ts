/**
 * M7A T7A.1 — Git unified-diff parser
 *
 * Parses the output of `git diff` to identify changed functions and methods.
 * Language support: TypeScript, JavaScript, PHP.
 *
 * Strategy:
 *  1. Split the diff into per-file sections.
 *  2. For each hunk, walk added (`+`) lines.
 *  3. Apply language-appropriate regex patterns to detect function/method declarations.
 *  4. Track class context within each hunk using context lines so that methods
 *     carry a `className`.
 *
 * We intentionally avoid false-positives: control-flow keywords, common builtins,
 * and single-letter identifiers are filtered out.
 */

import type { ChangedFunction } from '@tracegraph/shared-types';

// ─── Internal types ───────────────────────────────────────────────────────────

type HunkLine = {
  type:    '+' | '-' | ' ';
  content: string;
  newLine: number;
};

type DiffHunk = {
  newStart: number;
  lines:    HunkLine[];
};

type DiffFile = {
  file:  string;
  hunks: DiffHunk[];
};

// ─── Language detection ───────────────────────────────────────────────────────

function isTsOrJs(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(file);
}

function isPhp(file: string): boolean {
  return /\.php$/.test(file);
}

// ─── Noise filter ─────────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally',
  'return', 'new', 'class', 'import', 'export', 'const', 'let', 'var', 'async',
  'await', 'typeof', 'instanceof', 'void', 'throw', 'delete', 'in', 'of',
  'static', 'get', 'set', 'super', 'extends', 'implements', 'interface', 'type',
  'enum', 'namespace', 'module', 'declare', 'abstract', 'override', 'readonly',
  'public', 'private', 'protected', 'constructor',
]);

function isNoise(name: string): boolean {
  return KEYWORDS.has(name) || name.length <= 1 || /^_+$/.test(name);
}

// ─── Function patterns ────────────────────────────────────────────────────────

/**
 * TypeScript / JavaScript function declaration patterns.
 * Each pattern captures the function/method name in group 1.
 */
const TS_FUNCTION_PATTERNS: RegExp[] = [
  // Named function: function foo(  /  async function foo(  /  export function foo(
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/,

  // Const/let arrow or function expression: const foo = ( / const foo = async (
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/,

  // Class method (public/private/protected/static/async/override/abstract):
  //   methodName(  /  async methodName(
  /^\s*(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*\S.*?)?\s*\{/,
];

/**
 * PHP function declaration patterns.
 * Captures the function name in group 1.
 */
const PHP_FUNCTION_PATTERNS: RegExp[] = [
  // public/private/protected/static/abstract function foo(
  /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
];

/** Class declaration pattern (any language). */
const CLASS_PATTERN = /^\s*(?:(?:export|abstract|final)\s+)*class\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

// ─── Per-line extraction ──────────────────────────────────────────────────────

function extractFunctionName(content: string, file: string): string | undefined {
  const patterns = isTsOrJs(file)
    ? TS_FUNCTION_PATTERNS
    : isPhp(file)
    ? PHP_FUNCTION_PATTERNS
    : [...TS_FUNCTION_PATTERNS, ...PHP_FUNCTION_PATTERNS];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1] && !isNoise(match[1])) {
      return match[1];
    }
  }
  return undefined;
}

function extractClassName(content: string): string | undefined {
  const match = content.match(CLASS_PATTERN);
  return match?.[1] && !isNoise(match[1]) ? match[1] : undefined;
}

// ─── Diff text parser ─────────────────────────────────────────────────────────

function parseDiffFiles(diffText: string): DiffFile[] {
  const files: DiffFile[]  = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let newLineNum = 0;

  for (const rawLine of diffText.split('\n')) {
    // New file header: +++ b/src/foo.ts
    if (rawLine.startsWith('+++ b/')) {
      const file = rawLine.slice(6).trim();
      currentFile = { file, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    // Skip binary/dev-null diffs
    if (rawLine.startsWith('+++ /dev/null')) {
      currentFile = null;
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum  = parseInt(hunkMatch[1]!, 10);
      currentHunk = { newStart: newLineNum, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (rawLine.startsWith('+')) {
      currentHunk.lines.push({ type: '+', content: rawLine.slice(1), newLine: newLineNum });
      newLineNum++;
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({ type: '-', content: rawLine.slice(1), newLine: newLineNum });
      // removed lines do NOT advance the new-file line counter
    } else if (rawLine.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      // Context line
      const content = rawLine.length > 0 ? rawLine.slice(1) : '';
      currentHunk.lines.push({ type: ' ', content, newLine: newLineNum });
      newLineNum++;
    }
  }

  return files;
}

// ─── Changed function extraction ──────────────────────────────────────────────

function extractFromFile(file: DiffFile): ChangedFunction[] {
  const result: ChangedFunction[] = [];
  const seen = new Set<string>();

  for (const hunk of file.hunks) {
    // Track class context within this hunk (context lines + added lines, not removed)
    let currentClass: string | undefined;

    for (const line of hunk.lines) {
      // Update class context from non-removed lines
      if (line.type !== '-') {
        const cls = extractClassName(line.content);
        if (cls) currentClass = cls;
      }

      // Only extract function declarations from added lines
      if (line.type !== '+') continue;

      const fnName = extractFunctionName(line.content, file.file);
      if (!fnName) continue;

      // Deduplicate within the same file (same class+name can appear in multiple hunks)
      const key = `${file.file}|${currentClass ?? ''}|${fnName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry: ChangedFunction = {
        file:      file.file,
        startLine: line.newLine,
      };

      if (currentClass) {
        entry.className  = currentClass;
        entry.methodName = fnName;
      } else {
        entry.functionName = fnName;
      }

      result.push(entry);
    }
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a unified diff string and return all changed function/method declarations
 * found in added lines.
 *
 * @param diffText — raw output of `git diff`, `git diff HEAD~1 HEAD`, etc.
 * @returns Array of `ChangedFunction` — one entry per detected function/method.
 *          May include duplicates across files; deduplicated per file internally.
 */
export function parseDiff(diffText: string): ChangedFunction[] {
  if (!diffText.trim()) return [];
  const files = parseDiffFiles(diffText);
  return files.flatMap(extractFromFile);
}
