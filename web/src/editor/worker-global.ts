// The Kusto language service is Bridge.NET output and expects Node's `global`. A module of its own, so it runs before the service
// is evaluated: imports are hoisted above any statement of the importing file.
(globalThis as unknown as { global: unknown }).global = globalThis;
