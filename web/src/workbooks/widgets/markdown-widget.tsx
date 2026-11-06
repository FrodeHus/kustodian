import Markdown, { type Components } from 'react-markdown';
import { call } from '../../bridge';
import { withValues } from './with-values';

const components: Components = {
  a: ({ href, children }) =>
    href?.startsWith('https://') ? (
      <a
        href={href}
        className="btn"
        onClick={(e) => {
          e.preventDefault();
          void call('app.openLink', { url: href }).catch(() => undefined);
        }}
      >
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: () => null,
};

/** A Markdown widget: CommonMark through react-markdown (raw HTML off, default urlTransform), parameters substituted first. */
export function MarkdownWidget({ text, values }: { text: string; values: Record<string, string> }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12.5px]">
      <Markdown components={components}>{withValues(text, values)}</Markdown>
    </div>
  );
}
