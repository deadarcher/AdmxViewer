// A policy + a chosen state (+ element values) -> the exact registry writes that state implies. A line-for-line
// port of RFF's C# AdmxMaterializer (platform/src/RFF.Api/Services/AdmxMaterializer.cs), the code RFF Conformance
// uses to turn a Settings Catalog choice into baseline settings. Output is RFF's baseline setting shape
// (GroupMemberEvaluator.PolicySetting: scope/path/name/value/kind/absent/note), so an export from this page imports
// into a Conformance baseline unchanged. scripts/check-admx.mjs compares it with the C# original.

import type { AdmxSchema, Element, RegVal } from './admxParser';

export class AdmxMaterializeError extends Error {}

/** Mirrors AdmxMaterializer.DeleteChoice: "the enum item that DELETES the value". */
export const DELETE_CHOICE = '__rff_delete__';

export type PolicySetting = { scope: string; path: string; name: string; value?: string; kind: string; absent: boolean; note?: string };
export type MaterializeResult = { settings: PolicySetting[]; notes: string[] };
export type State = 'enabled' | 'disabled' | 'notconfigured';
/** Element id -> the UI value (boolean, number, string, string[], or {name, value}[] for explicit-value lists). */
export type ElementValues = Record<string, unknown>;

const blank = (v: string | undefined | null) => v == null || v.trim().length === 0;
const ieq = (a: string | undefined | null, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

export function materialize(cls: string, registryKey: string | undefined, valueName: string | undefined, displayName: string,
  schema: AdmxSchema, state: string, elementValues?: ElementValues): MaterializeResult {
  const enabled = ieq(state, 'enabled');
  const disabled = ieq(state, 'disabled');
  // The third gpedit state: assert every value this policy could write is absent, so removing a setting from a
  // baseline does not leave it tattooed on the machines that already got it.
  const notConfigured = ieq(state.replace(/-/g, '').replace(/ /g, ''), 'notconfigured');
  if (!enabled && !disabled && !notConfigured) throw new AdmxMaterializeError("state must be 'enabled', 'disabled' or 'notconfigured'.");

  const notes: string[] = [];
  const out = new Map<string, PolicySetting>();
  const stateLabel = enabled ? 'Enabled' : disabled ? 'Disabled' : 'Not configured';
  const noteText = `${displayName} - ${stateLabel} (Settings Catalog)`;

  const add = (key: string | undefined, name: string, val: RegVal) => {
    const path = blank(key) ? registryKey : key;
    if (blank(path)) throw new AdmxMaterializeError(`'${displayName}' declares no registry key for value '${name}'.`);
    const s: PolicySetting = { scope: cls, path: path!.trim().replace(/^\\+/, ''), name, kind: 'string', absent: false, note: noteText };
    if (val.delete) { s.absent = true; s.kind = 'dword'; }
    else { s.kind = val.kind; s.value = val.value ?? ''; }
    out.set((s.scope + '|' + s.path + '|' + s.name).toLowerCase(), s);
  };
  const addAbsent = (key: string | undefined, name: string) => add(key, name, { kind: 'dword', delete: true });

  if (enabled) {
    // Explicit enabledValue wins; a bare valueName means DWORD 1 (the ADMX default gpedit applies).
    if (!blank(valueName)) add(undefined, valueName!, schema.enabledValue ?? { kind: 'dword', value: '1', delete: false });
    for (const w of schema.enabledList) add(w.key, w.name, w.value);
    for (const el of schema.elements) materializeElement(el, elementValues, displayName, add, notes);
  } else if (disabled) {
    // Disabling writes disabledValue when declared, else DELETES the value, and un-configures every element value.
    if (!blank(valueName)) add(undefined, valueName!, schema.disabledValue ?? { kind: 'dword', delete: true });
    for (const w of schema.disabledList) add(w.key, w.name, w.value);
    for (const el of schema.elements) {
      if (!blank(el.valueName)) addAbsent(el.key, el.valueName!);
      else if (el.type === 'list')
        notes.push(`list values under '${el.key ?? registryKey}' are not removed on disable (their names aren't declared in the ADMX) - remove them from the baseline manually if needed.`);
    }
  } else {
    if (!blank(valueName)) addAbsent(undefined, valueName!);
    for (const w of schema.enabledList) addAbsent(w.key, w.name);
    for (const w of schema.disabledList) addAbsent(w.key, w.name);
    for (const el of schema.elements) {
      if (!blank(el.valueName)) addAbsent(el.key, el.valueName!);
      for (const w of el.trueList ?? []) addAbsent(w.key, w.name);
      for (const w of el.falseList ?? []) addAbsent(w.key, w.name);
      for (const it of el.items ?? []) for (const w of it.extra ?? []) addAbsent(w.key, w.name);
      if (el.type === 'list')
        notes.push(`entries under '${el.key ?? registryKey}' can't be removed automatically - a list element's value names aren't declared in the ADMX, so RFF doesn't know what to delete. Clear them on the computers or list them in the baseline by hand.`);
    }
  }

  if (out.size === 0)
    throw new AdmxMaterializeError(notConfigured
      ? `RFF can't work out what to remove for '${displayName}' - its values come entirely from list entries, whose names the ADMX doesn't declare.`
      : schema.elements.length > 0
        ? 'Choose at least one option above - this policy has no value of its own, so everything it writes comes from the options you pick.'
        : `'${displayName}' defines no registry writes for that state.`);
  return { settings: [...out.values()], notes };
}

/** C# long.TryParse. */
function tryLong(v: string | undefined | null): bigint | undefined {
  if (v == null || !/^\s*[+-]?\d+\s*$/.test(v)) return undefined;
  const b = BigInt(v.trim());
  return b < -(2n ** 63n) || b > 2n ** 63n - 1n ? undefined : b;
}

function materializeElement(el: Element, values: ElementValues | undefined, displayName: string,
  add: (key: string | undefined, name: string, val: RegVal) => void, notes: string[]) {
  const label = blank(el.label) ? el.id : el.label!;
  const raw = values && el.id in values && values[el.id] !== null && values[el.id] !== undefined ? values[el.id] : undefined;
  const fallback = raw === undefined ? el.defaultValue : undefined;
  if (raw === undefined && fallback == null) {
    if (el.required)
      throw new AdmxMaterializeError(ieq(label.replace(/:+$/, ''), displayName)
        ? `Enter a value for '${label.replace(/:+$/, '')}' to add this setting.`
        : `'${label}' is required for '${displayName}'.`);
    return;
  }
  switch (el.type) {
    case 'boolean': {
      const on = raw === true || (typeof raw === 'string' && ieq(raw, 'true')) || (raw === undefined && ieq(fallback, 'true'));
      if (blank(el.valueName) && (on ? el.trueList : el.falseList) == null) return;
      if (!blank(el.valueName))
        add(el.key, el.valueName!, on ? el.trueValue ?? { kind: 'dword', value: '1', delete: false } : el.falseValue ?? { kind: 'dword', value: '0', delete: false });
      for (const w of (on ? el.trueList : el.falseList) ?? []) add(w.key, w.name, w.value);
      break;
    }
    case 'decimal':
    case 'longDecimal': {
      const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : fallback;
      const n = tryLong(text);
      if (n === undefined) throw new AdmxMaterializeError(`'${label}' must be a whole number.`);
      if (el.min != null && n < BigInt(el.min)) throw new AdmxMaterializeError(`'${label}' must be at least ${el.min}.`);
      if (el.max != null && n > BigInt(el.max)) throw new AdmxMaterializeError(`'${label}' must be at most ${el.max}.`);
      if (blank(el.valueName)) return;
      add(el.key, el.valueName!, el.storeAsText
        ? { kind: 'string', value: n.toString(), delete: false }
        : { kind: el.type === 'longDecimal' ? 'qword' : 'dword', value: n.toString(), delete: false });
      break;
    }
    case 'text': {
      const text = typeof raw === 'string' ? raw : fallback ?? '';
      if (el.maxLength != null && text.length > el.maxLength) throw new AdmxMaterializeError(`'${label}' is limited to ${el.maxLength} characters.`);
      if (text.length === 0 && !el.required) return;
      if (blank(el.valueName)) return;
      add(el.key, el.valueName!, { kind: el.expandable ? 'expand' : 'string', value: text, delete: false });
      break;
    }
    case 'multiText': {
      let lines = Array.isArray(raw)
        ? raw.map((x) => (typeof x === 'string' ? x : ''))
        : (typeof raw === 'string' ? raw : fallback ?? '').split('\n').map((l) => l.replace(/\r+$/, ''));
      lines = lines.filter((l) => l.length > 0);
      if (lines.length === 0 && !el.required) return;
      if (blank(el.valueName)) return;
      // '\n'-joined is RFF's PolicySetting "multi" convention.
      add(el.key, el.valueName!, { kind: 'multi', value: lines.join('\n'), delete: false });
      break;
    }
    case 'enum': {
      const chosen = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : fallback;
      const item = el.items?.find((i) => i.value.value === chosen) ?? (chosen === DELETE_CHOICE ? el.items?.find((i) => i.value.delete) : undefined);
      if (!item) throw new AdmxMaterializeError(`'${label}': pick one of the listed options.`);
      if (!blank(el.valueName)) add(el.key, el.valueName!, item.value);
      for (const w of item.extra ?? []) add(w.key, w.name, w.value);
      break;
    }
    case 'list': {
      if (raw === undefined) return;
      if (!Array.isArray(raw)) throw new AdmxMaterializeError(`'${label}' expects a list of entries.`);
      const kind = el.expandable ? 'expand' : 'string';
      let i = 1;
      for (const entry of raw) {
        if (el.explicitValue) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new AdmxMaterializeError(`'${label}' takes a name and a value for each entry.`);
          const e = entry as { name?: unknown; value?: unknown };
          const name = typeof e.name === 'string' ? e.name : undefined;
          const val = typeof e.value === 'string' ? e.value : undefined;
          if (blank(name)) continue;
          add(el.key, name!, { kind, value: val ?? '', delete: false });
        } else {
          const val = typeof entry === 'string' ? entry : JSON.stringify(entry);
          if (val.length === 0) continue;
          // [MS-GPREG]: valuePrefix ABSENT -> the entry text is the value name; PRESENT (even empty) -> prefix+1..N.
          add(el.key, el.valuePrefix == null ? val : el.valuePrefix + i, { kind, value: val, delete: false });
          i++;
        }
      }
      if (el.additive) notes.push(`'${label}' is an additive list - entries merge with what's on the computer; RFF asserts the listed entries exist.`);
      break;
    }
  }
}
