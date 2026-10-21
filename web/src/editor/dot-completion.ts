import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { CompletionItem } from '../wire';

const AFTER_NAME = /[A-Za-z_][A-Za-z0-9_]*\.$/;

/** Whether the cursor sits right after `name.`, outside a string or a comment on its line. */
export function shouldAsk(textBeforeCursor: string): boolean {
  const line = textBeforeCursor.slice(textBeforeCursor.lastIndexOf('\n') + 1);
  if (!AFTER_NAME.test(line)) {
    return false;
  }
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return false;
    }
  }
  return quote === null;
}

// Monaco's CompletionItemKind values, spelled out so this file never loads the editor itself.
const FIELD = 3;
const PROPERTY = 9;

export type Complete = (kql: string, position: number, signal: AbortSignal) => Promise<CompletionItem[]>;

/**
 * Completion inside complex values (spec 6.2: `onPremisesPublishing.▮`, fields of `mv-expand`ed elements), which monaco-kusto
 * can't do because its schema has them as `dynamic`. Asks the host (`query.complete`) after a pause in typing, one request at a
 * time; `accepts` says which models it answers for.
 */
export function createDotProvider(complete: Complete, accepts: (uri: string) => boolean, debounceMs = 150): languages.CompletionItemProvider {
  let pending: { timer: ReturnType<typeof setTimeout>; settle: (items: CompletionItem[]) => void; abort: AbortController } | null = null;

  const supersede = () => {
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pending.abort.abort();
    pending.settle([]);
    pending = null;
  };

  return {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _context, token) {
      supersede();
      if (!accepts(model.uri.toString())) {
        return { suggestions: [] };
      }
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (!shouldAsk(before)) {
        return { suggestions: [] };
      }
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      const offset = model.getOffsetAt(position);
      const kql = model.getValue();
      let items: CompletionItem[];
      try {
        items = await new Promise<CompletionItem[]>((resolve) => {
          const timer = setTimeout(() => {
            complete(kql, offset, abort.signal).then(resolve, () => resolve([]));
          }, debounceMs);
          pending = { timer, settle: resolve, abort };
        });
      } finally {
        cancellation.dispose();
      }
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column,
        endColumn: position.column,
      };
      return {
        suggestions: items.map((i) => ({
          label: i.label,
          insertText: i.label,
          kind: i.kind === 'Property' ? PROPERTY : FIELD,
          detail: i.type,
          documentation: i.description,
          range,
        })),
      };
    },
  };
}
