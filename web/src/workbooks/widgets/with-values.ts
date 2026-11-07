/** `{name}` becomes the parameter's value, Markdown-escaped so a value can't add a link or a heading; unknown names stay. */
export function withValues(text: string, values: Record<string, string>): string {
  return text.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    return typeof value === 'string' ? value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&') : whole;
  });
}
