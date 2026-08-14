/**
 * @module bash-parse
 * Extracts file modification targets from bash commands.
 * Handles redirections and file-argument commands (rm, mv, cp, touch, tee).
 *
 * Known limitations (per R3Q3):
 * - Does not parse pipes, subshells, command substitution
 * - Does not handle variable expansion
 * - Does not parse && / ; compound commands
 */

/** Target type for bash file modification */
export interface BashTarget {
  /** Kind of modification */
  kind: "redirect" | "file-arg";
  /** Target file path */
  target: string;
}

/** Commands that take a file as the first non-flag argument */
const FILE_ARG_COMMANDS = new Set(["rm", "mv", "cp", "touch", "tee"]);

/** Redirection operators (order matters: longer first) */
const REDIRECT_OPS = [">>", ">|", ">"];

/**
 * Strips surrounding quotes and handles escape sequences from a string.
 *
 * @param s - Potentially quoted string
 * @returns Unquoted string
 */
function stripQuotes(s: string): string {
  // Handle single quotes
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  // Handle double quotes
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1);
  }
  // Handle backslash escapes (simple cases)
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Checks if a token looks like a flag (starts with -)
 */
function isFlag(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

/**
 * Extracts file modification targets from a bash command.
 *
 * @param command - The bash command string
 * @returns Array of file targets with their kind (redirect or file-arg)
 */
export function extractBashFileTargets(command: string): BashTarget[] {
  const targets: BashTarget[] = [];

  // Tokenize the command (simple split on whitespace, handles quoted strings)
  const tokens = tokenize(command);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Check for redirection operators (possibly attached to token)
    for (const op of REDIRECT_OPS) {
      const opIndex = token.indexOf(op);
      if (opIndex !== -1) {
        // Redirect found
        const afterOp = token.slice(opIndex + op.length);
        if (afterOp) {
          // Target is attached: >file
          targets.push({ kind: "redirect", target: stripQuotes(afterOp) });
        } else if (i + 1 < tokens.length) {
          // Target is next token: > file
          targets.push({ kind: "redirect", target: stripQuotes(tokens[i + 1]) });
          i++; // Skip next token
        }
        break; // Only process first redirect operator in this token
      }
    }

    // Check for file-argument commands
    if (FILE_ARG_COMMANDS.has(token)) {
      // Find the first non-flag argument
      let j = i + 1;
      let foundDoubleDash = false;
      while (j < tokens.length) {
        const arg = tokens[j];
        if (arg === "--") {
          foundDoubleDash = true;
          j++;
          continue;
        }
        if (foundDoubleDash || !isFlag(arg)) {
          targets.push({ kind: "file-arg", target: stripQuotes(arg) });
          break;
        }
        j++;
      }
    }
  }

  return targets;
}

/**
 * Simple tokenizer that handles quoted strings.
 * Does not handle all shell escape sequences.
 *
 * @param input - Command string
 * @returns Array of tokens
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
        current += char;
      } else {
        current += char;
      }
    } else if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
        current += char;
      } else if (char === "\\" && i + 1 < input.length) {
        // Escape sequence in double quotes
        current += char + input[i + 1];
        i++;
      } else {
        current += char;
      }
    } else {
      if (char === "'") {
        inSingleQuote = true;
        current += char;
      } else if (char === '"') {
        inDoubleQuote = true;
        current += char;
      } else if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
