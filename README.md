# ADMX Viewer

The engine behind **[ADMX Viewer](https://getrff.com/admx/)**: search 14,000+ Group Policy settings from Windows,
Microsoft 365, Edge, Chrome and 40 more vendors, see the registry key each one uses and what "Enabled", "Disabled" and
"Not configured" write, and get the Intune OMA-URI.

This repo is the part you can run yourself. It's plain TypeScript with no dependencies and runs in a browser or in
Node:

- **Parse** `.admx` and `.adml` files, one or a whole PolicyDefinitions folder (`admxParser.ts`, `xml.ts`).
- **Work out what each state writes**: every registry value a policy sets for "Enabled" with your options, for
  "Disabled", and what "Not configured" removes (`admxMaterialize.ts`).
- **Export** those values as a `.reg` file, a PowerShell script that applies them, or one that checks a computer
  against them (`exports.ts`).
- **Build your own ADMX**: write a matching `.admx` and `.adml` for your app or scripts, start from a `.reg` export or
  `reg query` output, nest categories, and generate a docs page and an Intune OMA-URI table to publish with it
  (`authoring.ts`).

The parser is a port of the C# parser in [RFF](https://getrff.com), and `scripts/check-admx.mjs` compares the two on
real Microsoft templates, field by field and registry write by registry write.

## Use it

```ts
import { parseBatch } from './src/lib/admx/admxParser';
import { materialize } from './src/lib/admx/admxMaterialize';
import { toReg } from './src/lib/admx/exports';

const [src] = parseBatch([{ fileName: 'WindowsUpdate.admx', admxXml, admlXml }]);
const p = src.settings.find((s) => s.policyName === 'AutoUpdateCfg')!;
const { settings } = materialize(p.class, p.registryKey, p.valueName, p.displayName, p.schema, 'enabled',
  { AutoUpdateMode: '4' });
console.log(toReg(settings));
```

Build an ADMX from registry values your app already reads:

```ts
import { parseRegistryImport, buildAdmx, buildDocs } from './src/lib/admx/authoring';

const imp = parseRegistryImport(regFileText);
const spec = { product: 'Agent', vendor: 'Fabrikam', namespace: 'Fabrikam.Policies.Agent', prefix: 'fabrikam', ...imp.spec };
const { admx, adml } = buildAdmx(spec);
const { markdown } = buildDocs(spec);
```

## Check it

```
npm install
npm run check
```

`check-admx.mjs` parses the templates in `scripts/fixtures/admx/PolicyDefinitions` and compares every policy and every
registry write with `scripts/fixtures/admx/golden`. The golden files are what RFF's C# code produced for the same templates.
`check-admx-authoring.mjs` builds templates with every setting type, nested categories and imported `.reg` files, and
proves each one loads.

## Feedback

Found a wrong registry value, a template that won't load, or a catalog you want on the site?
[Open an issue](https://github.com/deadarcher/AdmxViewer/issues/new) or email brian@getrff.com.

## License

MIT. Policy names and help text in the fixtures are Microsoft's, from their published Administrative Templates.
