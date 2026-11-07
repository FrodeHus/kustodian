import { useState, type ReactNode } from 'react';
import { call } from '../bridge';
import type { Row } from '../results/export';
import type { Notice } from '../results/result-grid';
import { RunToolDialog } from '../results/run-tool';
import { startMapping, type ColumnMapping } from '../results/tool-args';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import type { ExternalTool, ResultColumn, ToolList } from '../wire';
import type { ToolButton, Widget } from './model';
import { buttonName, effectiveSelection, okResult, toolTarget } from './tool-buttons';
import { useWorkbooks } from './workbook-store';

interface Opened {
  tool: ExternalTool;
  columns: ResultColumn[];
  rows: Row[];
  title: string;
  initialMapping: ColumnMapping;
  onRan: () => void;
}

/** Opens a button's run: reads tools.list, finds the tool by name, and shows RunToolDialog on the rows toolTarget chooses.
 * Problems go to onNotice. */
export function useToolRun(tabId: string, widget: Widget, onNotice: (n: Notice) => void): { open(button: ToolButton): void; dialog: ReactNode } {
  const [opened, setOpened] = useState<Opened | null>(null);
  const editTools = {
    label: 'Edit tools…',
    onClick: () => void call('tools.edit').catch((e: unknown) => onNotice({ tone: 'bad', text: errorText(e), reportId: reportIdOf(e) })),
  };

  const open = (button: ToolButton) => {
    const s = useWorkbooks.getState().byTab[tabId];
    const result = okResult(s?.runs[widget.id]);
    if (!result) {
      return;
    }
    // A snapshot: the dialog keeps these rows whatever the widget does meanwhile.
    const target = toolTarget(button.runsOn, result.rows, effectiveSelection(widget.selection, s?.selections[widget.id]));
    if (target.rows.length === 0) {
      return;
    }
    // Captured now, so the refresh goes to this widget whatever renders meanwhile.
    const widgetId = widget.id;
    const onRan = () => {
      const store = useWorkbooks.getState();
      if (button.after === 'refreshWidget') {
        void store.runWidget(tabId, widgetId, { refresh: true });
      } else if (button.after === 'refreshWorkbook') {
        void store.runAll(tabId, { refresh: true });
      }
    };
    call<ToolList>('tools.list').then(
      (list) => {
        const tool = list.tools.find((t) => t.name === button.tool);
        if (list.problem) {
          onNotice({ tone: 'bad', text: list.problem, action: editTools });
        } else if (!tool) {
          onNotice({ tone: 'bad', text: `There's no tool named ${button.tool} in your tools.json.`, action: editTools });
        } else {
          setOpened({
            tool,
            columns: result.columns,
            rows: target.rows,
            title: `${buttonName(button)} ${target.heading}`,
            initialMapping: startMapping(tool, result.columns, button.mapping),
            onRan,
          });
        }
      },
      (e: unknown) => onNotice({ tone: 'bad', text: errorText(e), reportId: reportIdOf(e), action: editTools }),
    );
  };

  return { open, dialog: opened && <RunToolDialog {...opened} onClose={() => setOpened(null)} /> };
}
