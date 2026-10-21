/** Whether a character is a control character, as .NET's `char.IsControl` counts them (U+0000–U+001F and U+007F–U+009F). */
const isControl = (code: number) => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/**
 * A KQL string literal in `quote` quotes, escaped as the host escapes parameter values (`ParameterSubstitution.Text`):
 * backslash and the quote, `\n`, `\r` and `\t`, and every other control character as `\uXXXX`. It can't end early or span
 * lines.
 */
export function kqlString(value: string, quote: '"' | "'" = '"'): string {
  let literal = quote;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === quote) {
      literal += `\\${ch}`;
    } else if (ch === '\n') {
      literal += '\\n';
    } else if (ch === '\r') {
      literal += '\\r';
    } else if (ch === '\t') {
      literal += '\\t';
    } else if (isControl(code)) {
      literal += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      literal += ch;
    }
  }
  return literal + quote;
}
