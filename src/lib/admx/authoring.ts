// "Build your own ADMX": turns a form (product, namespace, categories, policies) into a matching .admx/.adml pair in
// Microsoft's PolicyDefinitions schema, plus what a vendor publishes next to it: an Intune OMA-URI table and a docs
// page. The page parses every result with the site's own engine (admxParser.ts, proven equal to RFF's C# parser)
// before offering the download, so a file that wouldn't load never leaves the page. parseRegistryImport() starts a
// template from a vendor's existing .reg export, `reg query` output or a plain list of values.

export type AuthorPolicyType = 'onoff' | 'text' | 'number' | 'choice' | 'multitext';
export type AuthorPolicy = {
  name: string; display: string; explain: string; scope: 'machine' | 'user' | 'both';
  valueName: string; type: AuthorPolicyType;
  min?: number; max?: number;
  choices?: Array<{ display: string; value: number }>;
  /** The AuthorCategory.id it sits in; missing or unknown = the first category. */
  category?: string;
  /** A key of its own; missing = the spec's registryKey. */
  key?: string;
};
/** parent = another category's id; missing, unknown or circular = a top-level category. */
export type AuthorCategory = { id: string; name: string; parent?: string };
export type AuthorSpec = {
  product: string; vendor: string; namespace: string; prefix: string; registryKey: string;
  categories: AuthorCategory[]; policies: AuthorPolicy[];
};

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** An id ADMX accepts: letters, digits and underscores, not starting with a digit. */
export const toId = (s: string, fallback = 'Policy') => {
  const id = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !id ? fallback : /^[0-9]/.test(id) ? `P_${id}` : id;
};
const cls = (scope: AuthorPolicy['scope']) => (scope === 'machine' ? 'Machine' : scope === 'user' ? 'User' : 'Both');
const trimKey = (k: string) => k.trim().replace(/^\\+|\\+$/g, '');

type Resolved = {
  fileBase: string; prefix: string;
  cats: Array<{ src: AuthorCategory; admxId: string; parentAdmxId?: string }>;
  /** Each policy with its final id, key, value name and category chain (ADMX category ids, root first). */
  pols: Array<{ p: AuthorPolicy; id: string; key: string; valueName: string; catId: string; chain: string[] }>;
};

/** Ids, keys and category chains, worked out once so the ADMX, the Intune table and the docs can't disagree. */
function resolve(spec: AuthorSpec): Resolved {
  const cats0 = spec.categories.length ? spec.categories : [{ id: 'c1', name: spec.product || 'Settings' }];
  const used = new Set<string>();
  const admxIdOf = new Map<string, string>();
  for (const c of cats0) {
    let id = `Cat_${toId(c.name, 'Settings')}`;
    for (let n = 2; used.has(id.toLowerCase()); n++) id = `Cat_${toId(c.name, 'Settings')}_${n}`;
    used.add(id.toLowerCase());
    admxIdOf.set(c.id, id);
  }
  // A parent that doesn't exist, or that leads back to the category itself, makes it top-level.
  const parentOf = (c: AuthorCategory): string | undefined => {
    if (!c.parent || c.parent === c.id || !admxIdOf.has(c.parent)) return undefined;
    const seen = new Set([c.id]);
    for (let p: string | undefined = c.parent; p; p = cats0.find((k) => k.id === p)?.parent) {
      if (seen.has(p)) return undefined;
      seen.add(p);
    }
    return c.parent;
  };
  const cats = cats0.map((c) => ({ src: c, admxId: admxIdOf.get(c.id)!, parentAdmxId: parentOf(c) ? admxIdOf.get(parentOf(c)!) : undefined }));
  const chainOf = (catKey: string) => {
    const out: string[] = [];
    for (let c = cats.find((k) => k.src.id === catKey); c; c = c.parentAdmxId ? cats.find((k) => k.admxId === c!.parentAdmxId) : undefined) out.unshift(c.admxId);
    return out;
  };
  const polUsed = new Set<string>();
  const pols = spec.policies.map((p) => {
    let id = toId(p.name);
    for (let n = 2; polUsed.has(id.toLowerCase()); n++) id = `${toId(p.name)}_${n}`;
    polUsed.add(id.toLowerCase());
    const catKey = p.category && admxIdOf.has(p.category) ? p.category : cats0[0].id;
    return { p, id, key: trimKey(p.key || spec.registryKey), valueName: p.valueName.trim() || id, catId: admxIdOf.get(catKey)!, chain: chainOf(catKey) };
  });
  return { fileBase: toId(spec.product, 'MyApp'), prefix: toId(spec.prefix, 'vendor').toLowerCase(), cats, pols };
}

export function buildAdmx(spec: AuthorSpec): { admx: string; adml: string; fileBase: string } {
  const r = resolve(spec);
  const pol: string[] = [], strings: Array<[string, string]> = [], presentations: string[] = [];
  for (const c of r.cats) strings.push([c.admxId, c.src.name || 'Settings']);
  strings.push(['SUPPORTED_ANY', `Any version of ${spec.product}`]);

  for (const { p: p0, id: name, key, valueName, catId } of r.pols) {
    strings.push([name, p0.display || name], [`${name}_Help`, p0.explain || p0.display || name]);
    const head = `    <policy name="${name}" class="${cls(p0.scope)}" displayName="$(string.${name})" explainText="$(string.${name}_Help)" key="${x(key)}"`;
    const common = `      <parentCategory ref="${catId}" />\n      <supportedOn ref="SUPPORTED_ANY" />`;
    if (p0.type === 'onoff') {
      pol.push(`${head} valueName="${x(valueName)}">\n${common}\n      <enabledValue><decimal value="1" /></enabledValue>\n      <disabledValue><decimal value="0" /></disabledValue>\n    </policy>`);
      continue;
    }
    const elId = `${name}_Value`;
    let element = '', control = '';
    if (p0.type === 'text') {
      element = `<text id="${elId}" valueName="${x(valueName)}" required="true" />`;
      control = `<textBox refId="${elId}"><label>${x(p0.display || name)}:</label></textBox>`;
    } else if (p0.type === 'multitext') {
      element = `<multiText id="${elId}" valueName="${x(valueName)}" required="true" />`;
      control = `<multiTextBox refId="${elId}">${x(p0.display || name)}:</multiTextBox>`;
    } else if (p0.type === 'number') {
      const lim = `${p0.min != null ? ` minValue="${Math.max(0, Math.trunc(p0.min))}"` : ''}${p0.max != null ? ` maxValue="${Math.trunc(p0.max)}"` : ''}`;
      element = `<decimal id="${elId}" valueName="${x(valueName)}" required="true"${lim} />`;
      control = `<decimalTextBox refId="${elId}" defaultValue="${Math.max(0, Math.trunc(p0.min ?? 0))}">${x(p0.display || name)}:</decimalTextBox>`;
    } else {
      const items = (p0.choices?.length ? p0.choices : [{ display: 'Option 1', value: 1 }]).map((c, i) => {
        strings.push([`${name}_Item${i + 1}`, c.display || `Option ${i + 1}`]);
        return `          <item displayName="$(string.${name}_Item${i + 1})"><value><decimal value="${Math.trunc(c.value)}" /></value></item>`;
      });
      element = `<enum id="${elId}" valueName="${x(valueName)}" required="true">\n${items.join('\n')}\n        </enum>`;
      control = `<dropdownList refId="${elId}" noSort="true" defaultItem="0">${x(p0.display || name)}:</dropdownList>`;
    }
    pol.push(`${head} presentation="$(presentation.${name})">\n${common}\n      <elements>\n        ${element}\n      </elements>\n    </policy>`);
    presentations.push(`      <presentation id="${name}">\n        ${control}\n      </presentation>`);
  }

  const catXml = r.cats.map((c) => c.parentAdmxId
    ? `    <category name="${c.admxId}" displayName="$(string.${c.admxId})">\n      <parentCategory ref="${c.parentAdmxId}" />\n    </category>`
    : `    <category name="${c.admxId}" displayName="$(string.${c.admxId})" />`);
  const admx = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${x(spec.product)} policy template. Made with https://getrff.com/admx/build/ -->
<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="${r.prefix}" namespace="${x(spec.namespace)}" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <supportedOn>
    <definitions>
      <definition name="SUPPORTED_ANY" displayName="$(string.SUPPORTED_ANY)" />
    </definitions>
  </supportedOn>
  <categories>
${catXml.join('\n')}
  </categories>
  <policies>
${pol.join('\n')}
  </policies>
</policyDefinitions>
`;
  const adml = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>${x(spec.product)}</displayName>
  <description>${x(spec.vendor)} ${x(spec.product)} policy settings</description>
  <resources>
    <stringTable>
${strings.map(([id, t]) => `      <string id="${id}">${x(t)}</string>`).join('\n')}
    </stringTable>
    <presentationTable>
${presentations.join('\n')}
    </presentationTable>
  </resources>
</policyDefinitionResources>
`;
  return { admx, adml, fileBase: r.fileBase };
}

// ---------------------------------------------------------------------------------------------------------------
// Intune: ADMX ingestion (learn.microsoft.com/windows/client-management/win32-and-centennial-app-policy-configuration).
// The template goes in once through ConfigOperations/ADMXInstall, then each setting is an OMA-URI under
// Policy/Config/{AppName}~Policy~{category chain}/{policy}. Values follow "Understanding ADMX policies".

/** Ingested templates can't write under these keys (Microsoft lists a few Office and Explorer exceptions). */
const INGEST_BLOCKED = [/^system(\\|$)/i, /^software\\policies\\microsoft(\\|$)/i, /^software\\microsoft(\\|$)/i];
const INGEST_ALLOWED = [/^software\\policies\\microsoft\\office\\/i, /^software\\microsoft\\office\\/i,
  /^software\\microsoft\\windows\\currentversion\\explorer\\/i, /^software\\microsoft\\internet explorer\\/i,
  /^software\\policies\\microsoft\\windows\\currentversion\\explorer\\/i];
export const ingestBlocked = (key: string) => {
  const k = trimKey(key) + '\\';
  return INGEST_BLOCKED.some((re) => re.test(k)) && !INGEST_ALLOWED.some((re) => re.test(k));
};

export type IntuneRow = {
  id: string; display: string; scope: 'device' | 'user'; uri: string;
  enabled: string; disabled: string; blocked: boolean;
};
export type IntuneInfo = { appName: string; installUri: string; rows: IntuneRow[] };

export function intuneFor(spec: AuthorSpec): IntuneInfo {
  const r = resolve(spec);
  const appName = r.fileBase;
  const rows: IntuneRow[] = [];
  for (const { p, id, chain, key } of r.pols) {
    let data = '';
    if (p.type === 'text') data = `<data id="${id}_Value" value="your value"/>`;
    else if (p.type === 'multitext') data = `<data id="${id}_Value" value="first&#xF000;second"/>`;
    else if (p.type === 'number') data = `<data id="${id}_Value" value="${Math.max(0, Math.trunc(p.min ?? 0))}"/>`;
    else if (p.type === 'choice') data = `<data id="${id}_Value" value="${Math.trunc((p.choices?.[0]?.value) ?? 1)}"/>`;
    const scopes: Array<'device' | 'user'> = p.scope === 'both' ? ['device', 'user'] : [p.scope === 'user' ? 'user' : 'device'];
    for (const s of scopes) rows.push({
      id, display: p.display || id, scope: s,
      uri: `./${s === 'user' ? 'User' : 'Device'}/Vendor/MSFT/Policy/Config/${appName}~Policy~${chain.join('~')}/${id}`,
      enabled: `<enabled/>${data}`, disabled: '<disabled/>', blocked: ingestBlocked(key),
    });
  }
  return { appName, installUri: `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${appName}/Policy/${r.fileBase}`, rows };
}

// ---------------------------------------------------------------------------------------------------------------
// The docs page a vendor publishes next to the template: every setting with its registry value, what each state
// writes, and its Intune OMA-URI. Markdown (for a GitHub repo or docs site) and a standalone HTML page.

const hive = (s: 'machine' | 'user') => (s === 'user' ? 'HKCU' : 'HKLM');
const writes = (p: AuthorPolicy): [string, string] => {
  const kind = p.type === 'text' ? 'REG_SZ' : p.type === 'multitext' ? 'REG_MULTI_SZ' : 'REG_DWORD';
  if (p.type === 'onoff') return [`1 (${kind})`, `0 (${kind})`];
  if (p.type === 'choice') return [`the chosen value (${kind}): ${(p.choices ?? []).map((c) => `${c.display} = ${c.value}`).join(', ')}`, 'deletes the value'];
  if (p.type === 'number') return [`the number entered (${kind})${p.max != null ? `, ${p.min ?? 0} to ${p.max}` : p.min != null ? `, ${p.min} or more` : ''}`, 'deletes the value'];
  return [`the ${p.type === 'multitext' ? 'lines' : 'text'} entered (${kind})`, 'deletes the value'];
};
const scopeText = (s: AuthorPolicy['scope']) => (s === 'machine' ? 'Computer' : s === 'user' ? 'User' : 'Computer and user');

export function buildDocs(spec: AuthorSpec): { markdown: string; html: string; fileBase: string } {
  const r = resolve(spec);
  const it = intuneFor(spec);
  const catName = new Map(r.cats.map((c) => [c.admxId, c.src.name || 'Settings']));
  const path = (chain: string[]) => chain.map((c) => catName.get(c)).join(' > ');
  const groups = new Map<string, Resolved['pols']>();
  for (const p of r.pols) { const k = p.chain.join('|'); groups.set(k, [...(groups.get(k) ?? []), p]); }
  const product = spec.product || 'MyApp';
  const vendor = spec.vendor ? `${spec.vendor} ` : '';
  const anyBlocked = it.rows.some((row) => row.blocked);
  const md: string[] = [];
  md.push(`# ${vendor}${product} Group Policy settings`, '',
    `${vendor}${product} reads its settings from the registry, so you can set them with Group Policy or Intune. This page lists every setting in the ${r.fileBase}.admx template: where it shows in the editor, the registry value it writes, and its Intune OMA-URI.`, '',
    '## Install the template', '',
    `1. Copy \`${r.fileBase}.admx\` to \`C:\\Windows\\PolicyDefinitions\` and \`${r.fileBase}.adml\` to \`C:\\Windows\\PolicyDefinitions\\en-US\`.`,
    `2. For a domain, copy them to the Central Store instead: \`\\\\<domain>\\SYSVOL\\<domain>\\Policies\\PolicyDefinitions\` (the .adml in its \`en-US\` folder).`,
    `3. Open the Group Policy Management Editor. The settings are under Administrative Templates > ${path(r.pols[0]?.chain ?? []) || product}.`, '',
    '## Intune', '',
    'Either import the template in the Intune admin center (Devices > Configuration > Import ADMX, then a profile from Imported Administrative templates), or use a custom profile:', '',
    `1. Add the template once: OMA-URI \`${it.installUri}\`, data type String, value = the whole contents of ${r.fileBase}.admx.`,
    '2. Add each setting below with its OMA-URI, data type String, and the value shown.', '');
  if (anyBlocked) md.push('> Intune refuses to ingest templates that write under `System`, `Software\\Microsoft` or `Software\\Policies\\Microsoft`. The settings marked "Group Policy only" can only be set with Group Policy.', '');
  md.push('## Settings', '');
  for (const pols of groups.values()) {
    md.push(`### ${path(pols[0].chain)}`, '');
    for (const { p, id, key, valueName } of pols) {
      const [on, off] = writes(p);
      const scopes: Array<'machine' | 'user'> = p.scope === 'both' ? ['machine', 'user'] : [p.scope];
      md.push(`#### ${p.display || id}`, '');
      if (p.explain) md.push(p.explain.replace(/\r?\n/g, '  \n'), '');
      md.push('| | |', '|---|---|',
        `| Applies to | ${scopeText(p.scope)} |`,
        `| Registry | ${scopes.map((s) => `\`${hive(s)}\\${key}\\${valueName}\``).join('<br>')} |`,
        `| "Enabled" | ${on} |`, `| "Disabled" | ${off} |`, '| "Not configured" | Group Policy removes the value |');
      for (const row of it.rows.filter((x) => x.id === id)) {
        md.push(`| Intune (${row.scope}) | ${row.blocked ? 'Group Policy only' : `\`${row.uri}\`<br>\`${row.enabled}\``} |`);
      }
      md.push('');
    }
  }
  md.push(`Template generated with https://getrff.com/admx/build/`, '');
  const markdown = md.join('\n');

  const h = (s: string) => x(s);
  const body: string[] = [];
  for (const pols of groups.values()) {
    body.push(`<h2>${h(path(pols[0].chain))}</h2>`);
    for (const { p, id, key, valueName } of pols) {
      const [on, off] = writes(p);
      const scopes: Array<'machine' | 'user'> = p.scope === 'both' ? ['machine', 'user'] : [p.scope];
      body.push(`<h3 id="${id}">${h(p.display || id)}</h3>`, p.explain ? `<p>${h(p.explain).replace(/\r?\n/g, '<br>')}</p>` : '',
        '<table><tbody>',
        `<tr><th>Applies to</th><td>${scopeText(p.scope)}</td></tr>`,
        `<tr><th>Registry</th><td>${scopes.map((s) => `<code>${h(`${hive(s)}\\${key}\\${valueName}`)}</code>`).join('<br>')}</td></tr>`,
        `<tr><th>"Enabled"</th><td>${h(on)}</td></tr><tr><th>"Disabled"</th><td>${h(off)}</td></tr>`,
        '<tr><th>"Not configured"</th><td>Group Policy removes the value</td></tr>',
        ...it.rows.filter((row) => row.id === id).map((row) => `<tr><th>Intune (${row.scope})</th><td>${row.blocked ? 'Group Policy only' : `<code>${h(row.uri)}</code><br><code>${h(row.enabled)}</code>`}</td></tr>`),
        '</tbody></table>');
    }
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(`${vendor}${product}`)} Group Policy settings</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1d2330}code{font:13px Consolas,monospace;background:#f1f3f6;padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin:8px 0 22px}th,td{border:1px solid #dde1e7;padding:6px 10px;text-align:left;vertical-align:top}th{width:170px;background:#f7f8fa;font-weight:600}h2{margin-top:36px;border-bottom:1px solid #dde1e7;padding-bottom:4px}.note{background:#fff7e6;border:1px solid #f0c36d;padding:8px 12px;border-radius:6px}</style>
</head><body>
<h1>${h(`${vendor}${product}`)} Group Policy settings</h1>
<p>${h(`${vendor}${product}`)} reads its settings from the registry, so you can set them with Group Policy or Intune. This page lists every setting in the ${h(r.fileBase)}.admx template: where it shows in the editor, the registry value it writes, and its Intune OMA-URI.</p>
<h2>Install the template</h2>
<ol><li>Copy <code>${h(r.fileBase)}.admx</code> to <code>C:\\Windows\\PolicyDefinitions</code> and <code>${h(r.fileBase)}.adml</code> to <code>C:\\Windows\\PolicyDefinitions\\en-US</code>.</li>
<li>For a domain, copy them to the Central Store instead: <code>\\\\&lt;domain&gt;\\SYSVOL\\&lt;domain&gt;\\Policies\\PolicyDefinitions</code> (the .adml in its <code>en-US</code> folder).</li>
<li>Open the Group Policy Management Editor. The settings are under Administrative Templates &gt; ${h(path(r.pols[0]?.chain ?? []) || product)}.</li></ol>
<h2>Intune</h2>
<p>Either import the template in the Intune admin center (Devices &gt; Configuration &gt; Import ADMX, then a profile from Imported Administrative templates), or use a custom profile:</p>
<ol><li>Add the template once: OMA-URI <code>${h(it.installUri)}</code>, data type String, value = the whole contents of ${h(r.fileBase)}.admx.</li>
<li>Add each setting below with its OMA-URI, data type String, and the value shown.</li></ol>
${anyBlocked ? '<p class="note">Intune refuses to ingest templates that write under <code>System</code>, <code>Software\\Microsoft</code> or <code>Software\\Policies\\Microsoft</code>. The settings marked "Group Policy only" can only be set with Group Policy.</p>' : ''}
${body.filter(Boolean).join('\n')}
<p>Template generated with <a href="https://getrff.com/admx/build/">getrff.com/admx/build</a></p>
</body></html>
`;
  return { markdown, html, fileBase: r.fileBase };
}

// ---------------------------------------------------------------------------------------------------------------
// Import: a vendor's .reg export, `reg query` output, or plain "HKLM\Key\Value = data" lines, turned into a starting
// template. HKLM values become computer settings, HKCU (or HKEY_USERS\<sid>) user settings, the same value in both
// becomes "Computer and user". The longest key they share becomes the template's key; each subkey below it becomes a
// category, so the editor tree follows the registry.

type RegValue = { scope: 'machine' | 'user'; key: string; name: string; kind: 'dword' | 'qword' | 'sz' | 'expand' | 'multi' | 'binary'; data: string };
export type RegImport = {
  spec: Pick<AuthorSpec, 'registryKey' | 'categories' | 'policies'> & { product?: string; vendor?: string };
  notes: string[]; count: number;
};

function splitHive(full: string): { scope: 'machine' | 'user'; key: string } | null {
  const k = full.trim().replace(/^Registry::/i, '').replace(/^(HK[A-Z_]+):/i, '$1');
  const m = /^(HKEY_LOCAL_MACHINE|HKLM|HKEY_CURRENT_USER|HKCU|HKEY_USERS|HKU)(\\.*)?$/i.exec(k);
  if (!m) return null;
  let rest = trimKey(m[2] ?? '');
  const h = m[1].toUpperCase();
  if (h === 'HKEY_USERS' || h === 'HKU') rest = rest.replace(/^[^\\]+\\?/, ''); // drop the SID (or .DEFAULT)
  return { scope: h === 'HKEY_LOCAL_MACHINE' || h === 'HKLM' ? 'machine' : 'user', key: rest };
}

const hexBytes = (s: string) => s.replace(/[\s\\]/g, '').split(',').filter(Boolean).map((b) => parseInt(b, 16));
const utf16 = (bytes: number[]) => {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return out;
};

function readReg(text: string, notes: string[]): RegValue[] {
  const out: RegValue[] = [];
  // .reg continues a long hex value onto the next line with a trailing backslash.
  const lines = text.replace(/^\uFEFF/, '').replace(/\\\r?\n\s*/g, '').split(/\r?\n/);
  let cur: { scope: 'machine' | 'user'; key: string } | null = null;
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || /^(Windows Registry Editor|REGEDIT4)/i.test(line)) continue;
    if (/^\[/.test(line)) {
      // [-HKEY_...] deletes a key: nothing to template.
      cur = line.startsWith('[-') ? null : splitHive(line.replace(/^\[|\]$/g, ''));
      if (!cur && !line.startsWith('[-')) skipped++;
      continue;
    }
    // reg query: a bare key line, then "    Name    REG_TYPE    data" lines.
    if (/^(HKEY_|HKLM|HKCU|HKU)/i.test(line) && !/=/.test(line)) { cur = splitHive(line); if (!cur) skipped++; continue; }
    const rq = /^\s{2,}(.+?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(raw);
    if (rq && cur) {
      const [, name, t, d = ''] = rq;
      if (name === '(Default)') { notes.push(`Skipped the default value of ${cur.key}: an ADMX setting needs a value name.`); continue; }
      const kind = t === 'REG_DWORD' ? 'dword' : t === 'REG_QWORD' ? 'qword' : t === 'REG_SZ' ? 'sz' : t === 'REG_EXPAND_SZ' ? 'expand' : t === 'REG_MULTI_SZ' ? 'multi' : 'binary';
      const data = kind === 'dword' || kind === 'qword' ? String(parseInt(d, 16) || 0) : kind === 'multi' ? d.split('\\0').filter(Boolean).join('\n') : d;
      out.push({ ...cur, name, kind, data });
      continue;
    }
    // .reg value: "Name"=data or @=data, under the current [key].
    const rv = /^(@|"((?:[^"\\]|\\.)*)")\s*=\s*(.*)$/.exec(line);
    if (rv && cur) {
      if (rv[1] === '@') { notes.push(`Skipped the default value of ${cur.key}: an ADMX setting needs a value name.`); continue; }
      const name = rv[2].replace(/\\(.)/g, '$1');
      const v = rv[3].trim();
      if (v === '-') continue; // a deletion
      let m: RegExpExecArray | null;
      if ((m = /^"((?:[^"\\]|\\.)*)"$/.exec(v))) out.push({ ...cur, name, kind: 'sz', data: m[1].replace(/\\(.)/g, '$1') });
      else if ((m = /^dword:([0-9a-f]{1,8})$/i.exec(v))) out.push({ ...cur, name, kind: 'dword', data: String(parseInt(m[1], 16)) });
      else if ((m = /^hex\(b\):(.*)$/i.exec(v))) { const b = hexBytes(m[1]); out.push({ ...cur, name, kind: 'qword', data: String(b.reduceRight((a, n) => a * 256 + n, 0)) }); }
      else if ((m = /^hex\(2\):(.*)$/i.exec(v))) out.push({ ...cur, name, kind: 'expand', data: utf16(hexBytes(m[1])).replace(/\0+$/, '') });
      else if ((m = /^hex\(7\):(.*)$/i.exec(v))) out.push({ ...cur, name, kind: 'multi', data: utf16(hexBytes(m[1])).split('\0').filter(Boolean).join('\n') });
      else out.push({ ...cur, name, kind: 'binary', data: v });
      continue;
    }
    // Plain list: HKLM\Software\Policies\Contoso\Notes\DisableSync = 1 (a quoted or non-numeric value is text).
    const pl = /^(.+)\\([^\\=]+?)\s*=\s*(.*)$/.exec(line);
    if (pl) {
      const at = splitHive(pl[1]);
      if (!at) { skipped++; continue; }
      const d = pl[3].trim().replace(/^dword:/i, '');
      const quoted = /^".*"$/.test(d);
      const num = !quoted && /^(0x[0-9a-f]+|\d+)$/i.test(d);
      out.push({ ...at, name: pl[2].trim(), kind: num ? 'dword' : 'sz', data: num ? String(Number(d)) : d.replace(/^"|"$/g, '') });
      continue;
    }
    skipped++;
  }
  if (skipped) notes.push(`Skipped ${skipped} line${skipped === 1 ? '' : 's'} that weren't a key or value under HKLM, HKCU or HKEY_USERS.`);
  return out;
}

/** "DisableSync" -> "Disable sync", "max_retry_count" -> "Max retry count". */
export const humanize = (s: string) => {
  const words = s.replace(/[_\-.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim().split(/\s+/);
  // "ServerUrl" is written camel-case but read as "Server URL".
  const ACRONYMS = new Set(['url', 'uri', 'id', 'ip', 'dns', 'tls', 'ssl', 'vpn', 'api', 'ui', 'usb', 'pdf', 'http', 'https', 'smb', 'rdp', 'sso']);
  return words.map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0]?.toUpperCase() + w.slice(1) : /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
};

export function parseRegistryImport(text: string): RegImport {
  const notes: string[] = [];
  const vals = readReg(text, notes);
  // One setting per key + value name; the same one under HKLM and HKCU is "both".
  const byKey = new Map<string, RegValue & { scopes: Set<'machine' | 'user'> }>();
  for (const v of vals) {
    if (v.kind === 'binary') { notes.push(`Skipped ${v.key}\\${v.name}: binary values have no ADMX type.`); continue; }
    const k = `${v.key.toLowerCase()}|${v.name.toLowerCase()}`;
    const have = byKey.get(k);
    if (have) have.scopes.add(v.scope); else byKey.set(k, { ...v, scopes: new Set([v.scope]) });
  }
  const items = [...byKey.values()];
  if (!items.length) return { spec: { registryKey: '', categories: [], policies: [] }, notes: notes.length ? notes : ['No registry values found.'], count: 0 };

  // The longest key every value shares.
  const segs = items.map((i) => i.key.split('\\'));
  let n = 0;
  while (segs.every((s) => s.length > n && s[n].toLowerCase() === segs[0][n].toLowerCase())) n++;
  const base = segs[0].slice(0, n).join('\\');
  const after = /^software\\policies\\([^\\]+)(?:\\([^\\]+))?/i.exec(base);
  const product = after?.[2] ?? after?.[1] ?? segs[0][Math.max(0, n - 1)] ?? 'MyApp';
  const vendor = after?.[2] ? after[1] : undefined;
  if (!/^software\\policies(\\|$)/i.test(base)) notes.push(`${base || 'These keys'} isn't under Software\\Policies, so Group Policy leaves the values behind when a setting goes back to "Not configured".`);
  if (ingestBlocked(base)) notes.push('Intune can\'t ingest a template that writes there (System, Software\\Microsoft and Software\\Policies\\Microsoft are refused). Group Policy still works.');

  // A category for the product, and one per subkey below the shared key.
  const categories: AuthorCategory[] = [{ id: 'c1', name: product }];
  const catFor = (rel: string[]) => {
    let parent = 'c1';
    for (let i = 0; i < rel.length; i++) {
      const path = rel.slice(0, i + 1).join('\\').toLowerCase();
      let c = categories.find((k) => (k as AuthorCategory & { path?: string }).path === path);
      if (!c) { c = { id: `c${categories.length + 1}`, name: rel[i], parent, path } as AuthorCategory; categories.push(c); }
      parent = c.id;
    }
    return parent;
  };
  const policies: AuthorPolicy[] = items.map((v) => {
    const rel = v.key.split('\\').slice(n);
    const scope = v.scopes.size > 1 ? 'both' : [...v.scopes][0];
    const base0 = { name: toId(v.name), display: humanize(v.name), explain: '', scope, valueName: v.name, category: catFor(rel), key: rel.length ? v.key : undefined } as const;
    if (v.kind === 'dword' || v.kind === 'qword') {
      const num = Number(v.data);
      return num === 0 || num === 1 ? { ...base0, type: 'onoff' } : { ...base0, type: 'number', min: 0 };
    }
    if (v.kind === 'multi') return { ...base0, type: 'multitext' };
    if (v.kind === 'expand') notes.push(`${v.name} is REG_EXPAND_SZ; the template writes it as REG_SZ text.`);
    return { ...base0, type: 'text' };
  });
  for (const c of categories) delete (c as AuthorCategory & { path?: string }).path;
  return { spec: { registryKey: base, categories, policies, product, vendor }, notes, count: policies.length };
}
