import { useMemo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { call } from '../../bridge';
import { errorText } from '../../shell/errors';
import { withValues } from './with-values';

/** The widget's links: https ones only, with no href and not draggable, so a drop, middle-click or context menu can't navigate
 * the window (which has the bridge) to the page. They open in the user's browser through the host. */
function linkComponents(onFailed: (message: string | null) => void): Components {
  return {
    a: ({ href, children }) => {
      if (!href?.startsWith('https://')) {
        return <>{children}</>;
      }
      const open = () => {
        onFailed(null);
        call('app.openLink', { url: href }).catch((error: unknown) => onFailed(errorText(error)));
      };
      return (
        <span
          role="link"
          tabIndex={0}
          draggable={false}
          className="btn cursor-pointer"
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              open();
            }
          }}
        >
          {children}
        </span>
      );
    },
    img: () => null,
  };
}

/** A Markdown widget: CommonMark through react-markdown (raw HTML off, default urlTransform), parameters substituted first. */
export function MarkdownWidget({ text, values }: { text: string; values: Record<string, string> }) {
  const [failed, setFailed] = useState<string | null>(null);
  const components = useMemo(() => linkComponents(setFailed), []);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12.5px]">
      {failed && (
        <p role="alert" className="m-0 mb-2 text-[12px] text-bad">
          {failed}
        </p>
      )}
      <Markdown components={components}>{withValues(text, values)}</Markdown>
    </div>
  );
}
