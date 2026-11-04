// `{name}` placeholders are Kustodian's own query parameters (params/find-params.ts), filled in before a run. The Kusto parser
// flags them (KS213, "Client parameters are not supported or enabled") unless its global state allows client parameters, and
// monaco-kusto has no setting for that. Every state the worker builds starts from `GlobalState.Default`, so allowing them there
// reaches all of them.

interface GlobalState {
  WithProperty(type: unknown, property: unknown, value: boolean): GlobalState;
}

interface KustoGlobals {
  Kusto: {
    Language: {
      // shortcut: `s_default` is the private field behind the read-only `Default`; client-parameters.test.ts fails if an upgrade renames it.
      GlobalState: { readonly Default: GlobalState; s_default: GlobalState | null };
      Properties: { AllowClientParameters: unknown };
    };
  };
  System: { Boolean: unknown };
}

/** Lets the Kusto language service, once loaded, take `{name}` as a parameter of unknown type instead of an error. */
export function allowClientParameters(): void {
  const { Kusto, System } = globalThis as unknown as KustoGlobals;
  const { GlobalState, Properties } = Kusto.Language;
  GlobalState.s_default = GlobalState.Default.WithProperty(System.Boolean, Properties.AllowClientParameters, true);
}
