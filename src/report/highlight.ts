import { ts } from 'ts-morph'
import { COLOR, gray, green, magenta, yellow } from './ansi.js'

/**
 * Syntax highlighting through the TypeScript scanner rather than a regex or a new
 * dependency. The compiler is already the project's oracle for analysis; it ships a
 * real lexer, so template literals, regexes and nested comments tokenize correctly
 * instead of approximately.
 */
function colorFor(kind: ts.SyntaxKind, text: string): string {
  const K = ts.SyntaxKind

  if (kind === K.SingleLineCommentTrivia || kind === K.MultiLineCommentTrivia) return gray(text)
  if (
    kind === K.StringLiteral ||
    kind === K.NoSubstitutionTemplateLiteral ||
    kind === K.TemplateHead ||
    kind === K.TemplateMiddle ||
    kind === K.TemplateTail ||
    kind === K.RegularExpressionLiteral
  )
    return green(text)
  if (kind === K.NumericLiteral || kind === K.BigIntLiteral) return yellow(text)
  if (kind >= K.FirstKeyword && kind <= K.LastKeyword) return magenta(text)
  if (kind >= K.FirstPunctuation && kind <= K.LastPunctuation) return gray(text)

  return text // identifiers and whitespace stay plain, so names read as the content
}

/**
 * Highlighting is a display nicety, so it must never break a review: any scanner
 * trouble falls back to the original text rather than throwing.
 */
export function highlight(code: string, jsx = false): string {
  if (!COLOR || code === '') return code
  try {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
      code,
    )
    let out = ''
    let token = scanner.scan()
    // the guard bounds a pathological fragment; a code frame is only a few lines
    for (let i = 0; token !== ts.SyntaxKind.EndOfFileToken && i < 4000; i++) {
      out += colorFor(token, scanner.getTokenText())
      token = scanner.scan()
    }
    return out === '' ? code : out
  } catch {
    return code
  }
}

export function isJsx(file: string): boolean {
  return file.endsWith('.tsx') || file.endsWith('.jsx')
}
