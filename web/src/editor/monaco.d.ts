// monaco-editor ships types for its API, not for these entry points, which are imported for what they do when they load:
// edcore.main registers every editor feature (and no language), editor.worker is Monaco's own web worker, and kusto.worker is
// the Kusto language service's.
declare module 'monaco-editor/esm/vs/editor/edcore.main.js';
declare module 'monaco-editor/esm/vs/editor/editor.worker.js';
declare module '@kusto/monaco-kusto/release/esm/kusto.worker';
