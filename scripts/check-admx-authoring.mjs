/**
 * "Build your own ADMX" must only ever hand out files that load. Builds a template with every policy type and scope,
 * parses it with the site's ADMX engine (equal to RFF's C# parser, see check-admx.mjs), and checks each policy's
 * registry key, value and what Enabled writes. Also: odd input (spaces, leading digits, markup) still makes valid ids
 * and escaped text. Run: node scripts/check-admx-authoring.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(tmpdir(), 'rff-admx-author-entry.ts');
writeFileSync(entry, `export { buildAdmx, toId, intuneFor, buildDocs, parseRegistryImport, ingestBlocked, humanize } from ${JSON.stringify(join(root, 'src/lib/admx/authoring.ts').replace(/\\/g, '/'))};
export { parseBatch } from ${JSON.stringify(join(root, 'src/lib/admx/admxParser.ts').replace(/\\/g, '/'))};
export { materialize } from ${JSON.stringify(join(root, 'src/lib/admx/admxMaterialize.ts').replace(/\\/g, '/'))};`);
const out = join(tmpdir(), 'rff-admx-author.mjs');
buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'warning' });
const { buildAdmx, toId, intuneFor, buildDocs, parseRegistryImport, ingestBlocked, humanize, parseBatch, materialize } = await import(pathToFileURL(out).href + '?t=' + Date.now());

let fails = 0;
const check = (n, ok, d = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++; };

const spec = {
  product: 'Contoso Notes', vendor: 'Contoso', namespace: 'Contoso.Policies.Notes', prefix: 'contoso', registryKey: 'Software\\Policies\\Contoso\\Notes',
  categories: [{ id: 'c1', name: 'Contoso Notes' }, { id: 'c2', name: 'Sync', parent: 'c1' }, { id: 'c3', name: 'Loop A', parent: 'c4' }, { id: 'c4', name: 'Loop B', parent: 'c3' }],
  policies: [
    { name: 'DisableSync', display: 'Turn off sync', explain: 'Stops <sync> & "upload".', scope: 'machine', valueName: 'DisableSync', type: 'onoff' },
    { name: 'ServerUrl', display: 'Server URL', explain: 'Where to sync.', scope: 'both', valueName: 'ServerUrl', type: 'text', category: 'c2', key: 'Software\\Policies\\Contoso\\Notes\\Sync' },
    { name: 'Hosts', display: 'Allowed hosts', explain: 'One per line.', scope: 'machine', valueName: 'Hosts', type: 'multitext', category: 'c3' },
    { name: '9 Retry count', display: 'Retry count', explain: 'Retries.', scope: 'user', valueName: 'Retries', type: 'number', min: 1, max: 10 },
    { name: 'Theme', display: 'Theme', explain: 'Colour theme.', scope: 'machine', valueName: 'Theme', type: 'choice', choices: [{ display: 'Light', value: 0 }, { display: 'Dark', value: 1 }] },
  ],
};
const { admx, adml, fileBase } = buildAdmx(spec);
check('file name from the product', fileBase === 'Contoso_Notes', fileBase);
const parsed = parseBatch([{ fileName: `${fileBase}.admx`, admxXml: admx, admlXml: adml }]);
const s = parsed[0];
check('parses with no warnings', s && s.warnings.length === 0, JSON.stringify(s?.warnings ?? 'no result'));
const byName = (n) => s.settings.filter((x) => x.policyName === n);
check('five policies, "both" counted twice', s.settings.length === 6, String(s.settings.length));
check('nested category: Sync under Contoso Notes', byName('ServerUrl')[0]?.categoryPath === 'Contoso Notes > Sync', byName('ServerUrl')[0]?.categoryPath);
check('a policy key of its own', byName('ServerUrl')[0]?.registryKey === 'Software\\Policies\\Contoso\\Notes\\Sync', byName('ServerUrl')[0]?.registryKey);
check('circular parents fall back to top level', byName('Hosts')[0]?.categoryPath === 'Loop A', byName('Hosts')[0]?.categoryPath);
check('multiText element', byName('Hosts')[0]?.schema.elements[0]?.type === 'multiText', byName('Hosts')[0]?.schema.elements[0]?.type);
check('display names and category from the ADML', byName('DisableSync')[0]?.displayName === 'Turn off sync' && byName('DisableSync')[0]?.categoryPath === 'Contoso Notes', byName('DisableSync')[0]?.categoryPath);
check('markup in explain text is escaped, not broken', admx.includes('$(string.DisableSync_Help)') && adml.includes('Stops &lt;sync&gt; &amp; &quot;upload&quot;.'));
check('leading digit and spaces become a valid id', byName('P_9_Retry_count').length === 1 && toId('9 Retry count') === 'P_9_Retry_count');
check('ServerUrl is both computer and user', byName('ServerUrl').map((x) => x.class).sort().join(',') === 'machine,user');

const w = (n, cls, state, opts) => materialize(cls, byName(n)[0].registryKey, byName(n)[0].valueName, byName(n)[0].displayName, byName(n).find((x) => x.class === cls).schema, state, opts).settings;
const on = w('DisableSync', 'machine', 'enabled');
check('on/off: Enabled writes DisableSync = 1 (DWORD)', on.length === 1 && on[0].name === 'DisableSync' && on[0].value === '1' && on[0].kind === 'dword' && on[0].path === 'Software\\Policies\\Contoso\\Notes', JSON.stringify(on));
const off = w('DisableSync', 'machine', 'disabled');
check('on/off: Disabled writes 0', off[0]?.value === '0', JSON.stringify(off));
const url = w('ServerUrl', 'user', 'enabled', { ServerUrl_Value: 'https://notes.contoso.com' });
check('text: Enabled writes the string', url[0]?.name === 'ServerUrl' && url[0]?.value === 'https://notes.contoso.com' && url[0]?.kind === 'string', JSON.stringify(url));
const num = w('P_9_Retry_count', 'user', 'enabled', { P_9_Retry_count_Value: '5' });
check('number: Enabled writes a DWORD in range', num[0]?.name === 'Retries' && num[0]?.value === '5' && num[0]?.kind === 'dword', JSON.stringify(num));
const theme = w('Theme', 'machine', 'enabled', { Theme_Value: '1' });
check('choice: Enabled writes the chosen value', theme[0]?.name === 'Theme' && theme[0]?.value === '1', JSON.stringify(theme));

// Intune: one OMA-URI per scope, the chain of category ids inside the ADMX, and the ADMXInstall path.
const it = intuneFor(spec);
const srv = it.rows.filter((r) => r.id === 'ServerUrl');
check('Intune: install URI', it.installUri === './Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/Contoso_Notes/Policy/Contoso_Notes', it.installUri);
check('Intune: "both" gives a Device and a User URI with the nested chain', srv.length === 2 && srv[0].uri === './Device/Vendor/MSFT/Policy/Config/Contoso_Notes~Policy~Cat_Contoso_Notes~Cat_Sync/ServerUrl' && srv[1].uri.startsWith('./User/'), JSON.stringify(srv.map((r) => r.uri)));
check('Intune: text value payload', srv[0].enabled === '<enabled/><data id="ServerUrl_Value" value="your value"/>', srv[0].enabled);
check('Intune: on/off payload is a bare <enabled/>', it.rows.find((r) => r.id === 'DisableSync')?.enabled === '<enabled/>');
check('Intune: refused keys are spotted', ingestBlocked('Software\\Policies\\Microsoft\\Windows\\Foo') && ingestBlocked('SYSTEM\\CurrentControlSet') && !ingestBlocked('Software\\Policies\\Contoso') && !ingestBlocked('Software\\Policies\\Microsoft\\Office\\16.0'));

// Docs: every setting, its registry path and URI, no em dashes, the Group Policy states in quotes.
const docs = buildDocs(spec);
check('docs: each setting has a heading', ['Turn off sync', 'Server URL', 'Allowed hosts', 'Retry count', 'Theme'].every((d) => docs.markdown.includes(`#### ${d}`) && docs.html.includes(`>${d}</h3>`)));
check('docs: registry paths and URIs', docs.markdown.includes('`HKCU\\Software\\Policies\\Contoso\\Notes\\Sync\\ServerUrl`') && docs.markdown.includes(srv[1].uri));
check('docs: categories as sections', docs.markdown.includes('### Contoso Notes > Sync'));
check('docs: no em dashes', !/—/.test(docs.markdown + docs.html));
check('docs: HTML escapes the explain text', docs.html.includes('Stops &lt;sync&gt; &amp; &quot;upload&quot;.'));
check('humanize', humanize('DisableSync') === 'Disable sync' && humanize('max_retry_count') === 'Max retry count' && humanize('EnableURLCheck') === 'Enable URL check' && humanize('ServerUrl') === 'Server URL', humanize('ServerUrl'));

// Import: a .reg export, reg query output and a plain list all become the same kind of template.
const reg = `Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Fabrikam\\Agent]
"DisableTelemetry"=dword:00000001
"ServerUrl"="https://agent.fabrikam.com"
"Retries"=dword:0000000a
"CacheDir"=hex(2):25,00,54,00,45,00,4d,00,50,00,25,00,00,00
@="ignored"
"Blob"=hex:01,02

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Fabrikam\\Agent\\Proxy]
"Hosts"=hex(7):61,00,00,00,62,00,00,00,00,00

[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Fabrikam\\Agent]
"DisableTelemetry"=dword:00000000
`;
const imp = parseRegistryImport(reg);
const ip = (n) => imp.spec.policies.find((p) => p.valueName === n);
check('import .reg: five settings', imp.count === 5, String(imp.count));
check('import .reg: shared key, product and vendor', imp.spec.registryKey === 'SOFTWARE\\Policies\\Fabrikam\\Agent' && imp.spec.product === 'Agent' && imp.spec.vendor === 'Fabrikam', `${imp.spec.registryKey} ${imp.spec.product} ${imp.spec.vendor}`);
check('import .reg: HKLM + HKCU = both, 0/1 = on/off', ip('DisableTelemetry')?.scope === 'both' && ip('DisableTelemetry')?.type === 'onoff');
check('import .reg: other DWORD = number, string = text, REG_EXPAND_SZ = text', ip('Retries')?.type === 'number' && ip('ServerUrl')?.type === 'text' && ip('CacheDir')?.type === 'text');
check('import .reg: REG_MULTI_SZ in a subkey = multitext in a Proxy category with its own key', ip('Hosts')?.type === 'multitext' && ip('Hosts')?.key === 'SOFTWARE\\Policies\\Fabrikam\\Agent\\Proxy' && imp.spec.categories.find((c) => c.id === ip('Hosts')?.category)?.name === 'Proxy');
check('import .reg: default and binary values reported', imp.notes.some((n) => /default value/.test(n)) && imp.notes.some((n) => /Blob/.test(n)), JSON.stringify(imp.notes));
const built = buildAdmx({ product: imp.spec.product, vendor: imp.spec.vendor, namespace: 'Fabrikam.Policies.Agent', prefix: 'fabrikam', ...imp.spec });
const bp = parseBatch([{ fileName: 'Agent.admx', admxXml: built.admx, admlXml: built.adml }])[0];
check('import .reg: the template it starts parses', bp.warnings.length === 0 && bp.settings.length === 6 && bp.settings.find((x) => x.policyName === 'Hosts')?.categoryPath === 'Agent > Proxy', JSON.stringify(bp.warnings));

const rq = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Fabrikam\\Agent
    DisableTelemetry    REG_DWORD    0x1
    ServerUrl    REG_SZ    https://agent.fabrikam.com
`;
const rqi = parseRegistryImport(rq);
check('import reg query output', rqi.count === 2 && rqi.spec.policies.find((p) => p.valueName === 'DisableTelemetry')?.type === 'onoff', JSON.stringify(rqi));
const plain = parseRegistryImport('HKLM\\Software\\Policies\\Fabrikam\\Agent\\Retries = 5\nHKCU:\\Software\\Policies\\Fabrikam\\Agent\\Name = "7"');
check('import plain list (HKCU: form, quoted number stays text)', plain.count === 2 && plain.spec.policies.find((p) => p.valueName === 'Retries')?.type === 'number' && plain.spec.policies.find((p) => p.valueName === 'Name')?.type === 'text', JSON.stringify(plain.spec.policies));
const outside = parseRegistryImport('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Foo\\Bar = 1');
check('import outside Software\\Policies warns about tattooing and Intune', outside.notes.some((n) => /Software\\Policies/.test(n) && /Not configured/.test(n)) && outside.notes.some((n) => /Intune/.test(n)), JSON.stringify(outside.notes));
check('import nothing usable says so', parseRegistryImport('hello').count === 0);

console.log(`\n${fails ? fails + ' failure(s)' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
