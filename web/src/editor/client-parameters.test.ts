import '@kusto/language-service/bridge.min';
import '@kusto/language-service-next/Kusto.Language.Bridge.min';
import { expect, it } from 'vitest';
import { allowClientParameters } from './client-parameters';

interface Diagnostics {
  Count: number;
  getItem(i: number): { Code: string };
}
const { Kusto } = globalThis as unknown as {
  Kusto: {
    Language: {
      GlobalState: { Default: unknown };
      KustoCode: { ParseAndAnalyze(text: string, globals: unknown): { GetDiagnostics(): Diagnostics } };
    };
  };
};

const codes = (text: string) => {
  const diagnostics = Kusto.Language.KustoCode.ParseAndAnalyze(text, Kusto.Language.GlobalState.Default).GetDiagnostics();
  return Array.from({ length: diagnostics.Count }, (_, i) => diagnostics.getItem(i).Code);
};

it('takes {name} as a parameter once client parameters are allowed', () => {
  const query = 'print x = {companyName}';
  expect(codes(query)).toEqual(['KS213']);
  allowClientParameters();
  expect(codes(query)).toEqual([]);
});
