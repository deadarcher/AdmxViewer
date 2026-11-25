// ADMX + ADML -> policy settings. A line-for-line port of RFF's C# AdmxParser (platform/src/RFF.Api/Services/
// AdmxParser.cs), the parser behind RFF's Settings Catalog and Conformance, so a file parsed in a visitor's browser
// reads exactly as RFF would read it. scripts/check-admx.mjs compares the two on real Windows PolicyDefinitions;
// keep them in step (a change here without the C# side, or the reverse, fails that check).
//
// Batch-aware like the original: files parsed together resolve each other's category chains and supportedOn refs
// (windows.admx defines the roots the other files parent to).

import { parseXml, innerText, kids, kid, attr, type XEl } from './xml';

export type RegVal = { kind: string; value?: string; delete: boolean };
export type ListWrite = { key?: string; name: string; value: RegVal };
export type EnumItem = { display: string; value: RegVal; extra?: ListWrite[] };
export type Element = {
  id: string;
  /** boolean | decimal | longDecimal | text | multiText | enum | list */
  type: string;
  valueName?: string;
  key?: string;
  label?: string;
  required: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  defaultValue?: string;
  expandable: boolean;
  storeAsText: boolean;
  trueValue?: RegVal;
  falseValue?: RegVal;
  trueList?: ListWrite[];
  falseList?: ListWrite[];
  items?: EnumItem[];
  valuePrefix?: string;
  explicitValue: boolean;
  additive: boolean;
};
export type AdmxSchema = {
  enabledValue?: RegVal;
  disabledValue?: RegVal;
  enabledList: ListWrite[];
  disabledList: ListWrite[];
  elements: Element[];
};
export type AdmxFile = { fileName: string; admxXml: string; admlXml?: string | null };
export type ParsedSetting = {
  policyName: string; namespace: string; class: 'machine' | 'user'; displayName: string;
  explainText?: string; categoryPath?: string; registryKey?: string; valueName?: string; supportedOn?: string;
  schema: AdmxSchema;
};
export type ParsedSource = { fileName: string; namespace: string; prefix?: string; settings: ParsedSetting[]; warnings: string[] };

const MAX_WARNINGS_PER_FILE = 40;

type Pres = Map<string, { label?: string; def?: string }>;
type FileData = {
  namespace: string;
  prefix?: string;
  prefixMap: Map<string, string>;   // lower-cased prefix -> namespace
  strings: Map<string, string>;     // lower-cased id -> text
  presentations: Map<string, Pres>; // lower-cased presentation id -> lower-cased refId -> label/default
  policies: RawPolicy[];
  warnings: string[];
};
type RawPolicy = {
  name: string; cls: string; displayName: string; explainText?: string; key?: string; valueName?: string;
  categoryRef?: string; supportedOnRef?: string; schema: AdmxSchema;
};
type Ctx = {
  categories: Map<string, { display: string; parentRef?: string; file: FileData }>; // lower "ns|name"
  supportedOn: Map<string, string>;                                                  // lower "ns|name"
};

const lc = (s: string) => s.toLowerCase();
const trimMsg = (s: string) => (s.length > 200 ? s.slice(0, 200) : s);
const warn = (d: FileData, msg: string) => { if (d.warnings.length < MAX_WARNINGS_PER_FILE) d.warnings.push(msg); };
const isTrue = (v: string | undefined) => (v ?? '').toLowerCase() === 'true';
/** C# string.IsNullOrWhiteSpace. */
const blank = (v: string | undefined | null) => v == null || v.trim().length === 0;

/** C# long.TryParse / int.TryParse (InvariantCulture-ish): optional surrounding whitespace, optional sign, digits. */
function tryLong(v: string | undefined, bits: 32 | 64): number | undefined {
  if (v == null || !/^\s*[+-]?\d+\s*$/.test(v)) return undefined;
  const b = BigInt(v.trim());
  const lim = bits === 64 ? 2n ** 63n : 2n ** 31n;
  if (b < -lim || b > lim - 1n) return undefined;
  return Number(b);
}

export function parseBatch(files: AdmxFile[]): ParsedSource[] {
  const ctx: Ctx = { categories: new Map(), supportedOn: new Map() };
  const loaded = files.map((f) => {
    try { return { file: f, data: loadFile(f, ctx), error: undefined as string | undefined }; }
    catch (e) { return { file: f, data: undefined, error: trimMsg(e instanceof Error ? e.message : String(e)) }; }
  });
  const results: ParsedSource[] = [];
  for (const { file, data, error } of loaded) {
    if (!data) { results.push({ fileName: file.fileName, namespace: '', settings: [], warnings: [`failed to parse: ${error}`] }); continue; }
    const settings: ParsedSetting[] = [];
    for (const p of data.policies) {
      const catPath = resolveCategoryPath(ctx, data, p.categoryRef);
      const supported = resolveSupportedOn(ctx, data, p.supportedOnRef);
      // "Both" policies exist in gpedit under Computer AND User Configuration: one row per class.
      const classes: Array<'machine' | 'user'> = lc(p.cls) === 'both' ? ['machine', 'user'] : [lc(p.cls) === 'user' ? 'user' : 'machine'];
      for (const cls of classes)
        settings.push({
          policyName: p.name, namespace: data.namespace, class: cls, displayName: p.displayName,
          explainText: p.explainText, categoryPath: catPath, registryKey: p.key, valueName: p.valueName,
          supportedOn: supported, schema: p.schema,
        });
    }
    results.push({ fileName: file.fileName, namespace: data.namespace, prefix: data.prefix, settings, warnings: data.warnings.slice(0, MAX_WARNINGS_PER_FILE) });
  }
  return results;
}

function loadFile(file: AdmxFile, ctx: Ctx): FileData {
  const root = parseXml(file.admxXml);
  const d: FileData = { namespace: '', prefixMap: new Map(), strings: new Map(), presentations: new Map(), policies: [], warnings: [] };

  const nsNode = kid(root, 'policyNamespaces');
  const target = nsNode ? kid(nsNode, 'target') : undefined;
  d.namespace = target ? attr(target, 'namespace') ?? '' : '';
  d.prefix = target ? attr(target, 'prefix') : undefined;
  if (d.prefix != null) d.prefixMap.set(lc(d.prefix), d.namespace);
  if (nsNode)
    for (const u of kids(nsNode, 'using')) {
      const up = attr(u, 'prefix'), uns = attr(u, 'namespace');
      if (up != null && uns != null) d.prefixMap.set(lc(up), uns);
    }

  if (!blank(file.admlXml)) {
    try { loadAdml(file.admlXml!, d); }
    catch (e) { warn(d, `ADML parse failed (${trimMsg(e instanceof Error ? e.message : String(e))}) - using raw string ids`); }
  } else warn(d, 'no matching ADML - policy names/descriptions fall back to internal ids');

  const cats = kid(root, 'categories');
  if (cats)
    for (const c of kids(cats, 'category')) {
      const name = attr(c, 'name');
      if (name == null) continue;
      const display = resolve(d, attr(c, 'displayName'), name);
      const pc = kid(c, 'parentCategory');
      ctx.categories.set(lc(d.namespace + '|' + name), { display, parentRef: pc ? attr(pc, 'ref') : undefined, file: d });
    }

  const son = kid(root, 'supportedOn');
  const defs = son ? kid(son, 'definitions') : undefined;
  if (defs)
    for (const def of kids(defs, 'definition')) {
      const dn = attr(def, 'name');
      if (dn != null) ctx.supportedOn.set(lc(d.namespace + '|' + dn), resolve(d, attr(def, 'displayName'), dn));
    }

  const pols = kid(root, 'policies');
  if (pols)
    for (const p of kids(pols, 'policy')) {
      try { d.policies.push(loadPolicy(p, d)); }
      catch (e) { warn(d, `policy '${attr(p, 'name')}' skipped: ${trimMsg(e instanceof Error ? e.message : String(e))}`); }
    }
  return d;
}

function loadAdml(admlXml: string, d: FileData) {
  const root = parseXml(admlXml);
  const resources = kid(root, 'resources');
  if (!resources) return;
  const st = kid(resources, 'stringTable');
  if (st) for (const s of kids(st, 'string')) { const id = attr(s, 'id'); if (id != null) d.strings.set(lc(id), innerText(s)); }
  const pt = kid(resources, 'presentationTable');
  if (pt)
    for (const pres of kids(pt, 'presentation')) {
      const pid = attr(pres, 'id');
      if (pid == null) continue;
      const map: Pres = new Map();
      for (const el of pres.children) {
        const refId = attr(el, 'refId');
        if (refId == null) continue; // static <text> help rows have no refId
        const r = lc(refId);
        switch (el.name) {
          case 'dropdownList': map.set(r, { label: innerText(el).trim(), def: attr(el, 'defaultItem') }); break;
          case 'checkBox': map.set(r, { label: innerText(el).trim(), def: attr(el, 'defaultChecked') }); break;
          case 'decimalTextBox':
          case 'longDecimalTextBox': map.set(r, { label: innerText(el).trim(), def: attr(el, 'defaultValue') }); break;
          case 'textBox': { const l = kid(el, 'label'), dv = kid(el, 'defaultValue'); map.set(r, { label: l ? innerText(l).trim() : undefined, def: dv ? innerText(dv) : undefined }); break; }
          case 'comboBox': { const l = kid(el, 'label'), dv = kid(el, 'default'); map.set(r, { label: l ? innerText(l).trim() : undefined, def: dv ? innerText(dv) : undefined }); break; }
          case 'multiTextBox':
          case 'listBox': map.set(r, { label: innerText(el).trim(), def: undefined }); break;
        }
      }
      d.presentations.set(lc(pid), map);
    }
}

/** "$(string.Foo)" -> ADML text; anything else passes through. Missing id -> the id itself (warned). */
function resolve(d: FileData, raw: string | undefined, fallback: string): string {
  if (blank(raw)) return fallback;
  const s = raw!.trim();
  if (s.toLowerCase().startsWith('$(string.') && s.endsWith(')')) {
    const id = s.slice(9, -1);
    const text = d.strings.get(lc(id));
    if (text !== undefined) return text;
    warn(d, `unresolved string id '${id}'`);
    return id;
  }
  return s;
}

function loadPolicy(p: XEl, d: FileData): RawPolicy {
  const name = attr(p, 'name');
  if (name == null) throw new Error('policy without a name');
  const pc = kid(p, 'parentCategory'), so = kid(p, 'supportedOn');
  const pol: RawPolicy = {
    name, cls: attr(p, 'class') ?? 'Machine', displayName: resolve(d, attr(p, 'displayName'), name),
    key: attr(p, 'key'), valueName: attr(p, 'valueName'),
    categoryRef: pc ? attr(pc, 'ref') : undefined, supportedOnRef: so ? attr(so, 'ref') : undefined,
    schema: { enabledList: [], disabledList: [], elements: [] },
  };
  const explain = attr(p, 'explainText');
  if (explain != null) pol.explainText = resolve(d, explain, '');
  if (blank(pol.explainText)) pol.explainText = undefined;

  const ev = kid(p, 'enabledValue'), dv = kid(p, 'disabledValue'), el = kid(p, 'enabledList'), dl = kid(p, 'disabledList');
  if (ev) pol.schema.enabledValue = parseValue(ev);
  if (dv) pol.schema.disabledValue = parseValue(dv);
  if (el) pol.schema.enabledList = parseListWrites(el);
  if (dl) pol.schema.disabledList = parseListWrites(dl);

  let pres: Pres | undefined;
  const presRef = attr(p, 'presentation');
  if (presRef != null && presRef.toLowerCase().startsWith('$(presentation.') && presRef.endsWith(')'))
    pres = d.presentations.get(lc(presRef.slice(15, -1)));

  const els = kid(p, 'elements');
  if (els)
    for (const e of els.children) {
      const parsed = parseElement(e, d, pres);
      if (parsed) pol.schema.elements.push(parsed);
      else warn(d, `policy '${name}': unsupported element <${e.name}> skipped`);
    }
  return pol;
}

/** A value node: <decimal value=/> | <longDecimal/> | <string> | <delete/>. */
function parseValue(container: XEl): RegVal {
  const v = container.children[0];
  if (!v) return { kind: 'dword', delete: true };
  switch (v.name) {
    case 'decimal': return { kind: 'dword', value: attr(v, 'value') ?? '0', delete: false };
    case 'longDecimal': return { kind: 'qword', value: attr(v, 'value') ?? '0', delete: false };
    case 'string': return { kind: 'string', value: innerText(v), delete: false };
    case 'delete': return { kind: 'dword', delete: true };
    default: return { kind: 'string', value: innerText(v), delete: false };
  }
}

function parseListWrites(listNode: XEl): ListWrite[] {
  const defaultKey = attr(listNode, 'defaultKey');
  const writes: ListWrite[] = [];
  for (const item of kids(listNode, 'item')) {
    const vn = attr(item, 'valueName');
    if (vn == null) continue;
    const v = kid(item, 'value');
    writes.push({ key: attr(item, 'key') ?? defaultKey, name: vn, value: v ? parseValue(v) : { kind: 'dword', value: '1', delete: false } });
  }
  return writes;
}

function parseElement(e: XEl, d: FileData, pres: Pres | undefined): Element | null {
  const id = attr(e, 'id') ?? '';
  const p = pres && id.length > 0 ? pres.get(lc(id)) : undefined;
  const el: Element = {
    id, type: '', valueName: attr(e, 'valueName'), key: attr(e, 'key'), label: p?.label,
    required: isTrue(attr(e, 'required')), defaultValue: p?.def,
    expandable: false, storeAsText: false, explicitValue: false, additive: false,
  };
  switch (e.name) {
    case 'boolean': {
      el.type = 'boolean';
      const tv = kid(e, 'trueValue'), fv = kid(e, 'falseValue'), tl = kid(e, 'trueList'), fl = kid(e, 'falseList');
      if (tv) el.trueValue = parseValue(tv);
      if (fv) el.falseValue = parseValue(fv);
      if (tl) el.trueList = parseListWrites(tl);
      if (fl) el.falseList = parseListWrites(fl);
      break;
    }
    case 'decimal':
    case 'longDecimal':
      el.type = e.name;
      el.min = tryLong(attr(e, 'minValue'), 64);
      el.max = tryLong(attr(e, 'maxValue'), 64);
      el.storeAsText = isTrue(attr(e, 'storeAsText'));
      break;
    case 'text':
      el.type = 'text';
      el.expandable = isTrue(attr(e, 'expandable'));
      el.maxLength = tryLong(attr(e, 'maxLength'), 32);
      break;
    case 'multiText':
      el.type = 'multiText';
      break;
    case 'enum': {
      el.type = 'enum';
      el.items = [];
      for (const item of kids(e, 'item')) {
        const display = resolve(d, attr(item, 'displayName'), 'item ' + el.items.length);
        const v = kid(item, 'value');
        const vl = kid(item, 'valueList');
        el.items.push({ display, value: v ? parseValue(v) : { kind: 'dword', value: '0', delete: false }, extra: vl ? parseListWrites(vl) : undefined });
      }
      // ADML dropdownList defaultItem is an INDEX into the items: store the item's value string instead.
      const idx = tryLong(p?.def, 32);
      el.defaultValue = idx != null && idx >= 0 && idx < el.items.length ? el.items[idx].value.value : undefined;
      break;
    }
    case 'list':
      el.type = 'list';
      el.valuePrefix = attr(e, 'valuePrefix');
      el.additive = isTrue(attr(e, 'additive'));
      el.explicitValue = isTrue(attr(e, 'explicitValue'));
      el.expandable = isTrue(attr(e, 'expandable'));
      break;
    default:
      return null;
  }
  if (el.type === 'boolean' && el.defaultValue != null) el.defaultValue = isTrue(el.defaultValue) ? 'true' : 'false';
  return el;
}

const prettyRefName = (ref: string) => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);

/** Walk parentCategory chains through the batch. An external ref whose namespace isn't in the batch ends the walk
 *  with the ref's own name as the root segment (a lone vendor ADMX parents into windows.admx categories). */
function resolveCategoryPath(ctx: Ctx, file: FileData, categoryRef: string | undefined): string | undefined {
  if (blank(categoryRef)) return undefined;
  const segments: string[] = [];
  let currentRef: string | undefined = categoryRef;
  let currentFile = file;
  for (let depth = 0; currentRef != null && depth < 12; depth++) {
    const [ns, name] = splitRef(currentFile, currentRef);
    const cat = ns == null ? undefined : ctx.categories.get(lc(ns + '|' + name));
    if (!cat) { segments.push(prettyRefName(currentRef)); break; }
    segments.push(cat.display);
    currentRef = cat.parentRef;
    currentFile = cat.file;
  }
  segments.reverse();
  return segments.length === 0 ? undefined : segments.join(' > ');
}

function resolveSupportedOn(ctx: Ctx, file: FileData, ref: string | undefined): string | undefined {
  if (blank(ref)) return undefined;
  const [ns, name] = splitRef(file, ref!);
  const display = ns == null ? undefined : ctx.supportedOn.get(lc(ns + '|' + name));
  return display ?? prettyRefName(ref!);
}

/** "windows:Foo" -> [Microsoft.Policies.Windows, Foo] via the prefix map; "Foo" -> [own namespace, Foo]. */
function splitRef(file: FileData, ref: string): [string | undefined, string] {
  const i = ref.indexOf(':');
  if (i < 0) return [file.namespace, ref];
  const ns = file.prefixMap.get(lc(ref.slice(0, i)));
  return [ns, ref.slice(i + 1)];
}
