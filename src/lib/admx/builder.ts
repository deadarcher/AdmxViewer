// The "Build it" panel on a policy page (and for a visitor's own uploaded ADMX): pick a state and options, see the
// exact writes (admxMaterialize, RFF's rules), download them, or add them to a baseline kept in this browser.
// Vanilla DOM; every string from a file is set with textContent, never innerHTML.

import type { AdmxSchema, Element } from './admxParser';
import { materialize, AdmxMaterializeError, DELETE_CHOICE, type PolicySetting, type ElementValues } from './admxMaterialize';
import { toReg, toPowerShellApply, toPowerShellCheck } from './exports';

export type BuilderPolicy = { file: string; policy: string; displayName: string; registryKey?: string; valueName?: string; classes: Array<'machine' | 'user'>; schema: AdmxSchema };
export type BasketItem = { file: string; policy: string; displayName: string; cls: string; state: string; values: ElementValues; settings: PolicySetting[]; addedAt: string };

const BASKET = 'rff-admx-baseline';
export function readBasket(): BasketItem[] {
  try { return JSON.parse(localStorage.getItem(BASKET) || '[]') as BasketItem[]; } catch { return []; }
}
export function writeBasket(items: BasketItem[]) {
  try { localStorage.setItem(BASKET, JSON.stringify(items)); } catch { /* private mode: the basket just doesn't persist */ }
  window.dispatchEvent(new CustomEvent('rff-admx-basket'));
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: Array<Node | string>) => {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as { class?: string };
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const k of kids) el.append(k);
  return el;
};

/** Download text as a file: .reg as UTF-16LE with BOM (what regedit expects), .ps1 as UTF-8 with BOM (Windows
 *  PowerShell 5.1 reads a BOM-less file as the ANSI code page and mangles any non-ASCII value). */
export function download(name: string, text: string) {
  let blob: Blob;
  if (name.endsWith('.reg')) {
    const buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xff; buf[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); buf[2 + i * 2] = c & 0xff; buf[3 + i * 2] = c >> 8; }
    blob = new Blob([buf], { type: 'text/plain' });
  } else blob = new Blob([String.fromCharCode(0xfeff) + text], { type: 'text/plain;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

function input(el: Element, onChange: () => void): { node: HTMLElement; read: () => unknown } {
  const label = el.label || el.id;
  const wrap = h('label', { class: 'admx-field' }, h('span', { class: 'admx-field-label' }, label + (el.required ? ' (required)' : '')));
  switch (el.type) {
    case 'boolean': {
      const cb = h('input', { type: 'checkbox', checked: el.defaultValue === 'true' });
      cb.addEventListener('change', onChange);
      wrap.prepend(cb); wrap.classList.add('is-check');
      return { node: wrap, read: () => cb.checked };
    }
    case 'enum': {
      const sel = h('select');
      for (const it of el.items ?? []) sel.append(h('option', { value: it.value.delete ? DELETE_CHOICE : it.value.value ?? '', textContent: it.display }));
      if (el.defaultValue != null) sel.value = el.defaultValue;
      sel.addEventListener('change', onChange);
      wrap.append(sel);
      return { node: wrap, read: () => sel.value };
    }
    case 'decimal':
    case 'longDecimal': {
      const n = h('input', { type: 'number', value: el.defaultValue ?? '', placeholder: [el.min, el.max].some((x) => x != null) ? `${el.min ?? ''} to ${el.max ?? ''}` : '' });
      n.addEventListener('input', onChange);
      wrap.append(n);
      return { node: wrap, read: () => (n.value === '' ? undefined : n.value) };
    }
    case 'multiText':
    case 'list': {
      const ta = h('textarea', { rows: 3, placeholder: el.type === 'list' && el.explicitValue ? 'one per line: name=value' : 'one per line' });
      ta.addEventListener('input', onChange);
      wrap.append(ta);
      return {
        node: wrap, read: () => {
          const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return undefined;
          if (el.type === 'list' && el.explicitValue) return lines.map((l) => { const i = l.indexOf('='); return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i), value: l.slice(i + 1) }; });
          return lines;
        },
      };
    }
    default: {
      const t = h('input', { type: 'text', value: el.defaultValue ?? '', maxLength: el.maxLength ?? 1024 });
      t.addEventListener('input', onChange);
      wrap.append(t);
      return { node: wrap, read: () => (t.value === '' ? undefined : t.value) };
    }
  }
}

export function mountBuilder(host: HTMLElement, p: BuilderPolicy) {
  host.replaceChildren();
  let cls: string = p.classes[0];
  let state = 'enabled';
  let last: PolicySetting[] = [];

  const clsRow = h('div', { class: 'admx-seg', role: 'group' });
  if (p.classes.length > 1)
    for (const c of p.classes) {
      const b = h('button', { type: 'button', textContent: c === 'user' ? 'User' : 'Computer' });
      b.addEventListener('click', () => { cls = c; render(); });
      clsRow.append(b);
    }
  const stateRow = h('div', { class: 'admx-seg', role: 'group' });
  for (const [id, label] of [['enabled', 'Enabled'], ['disabled', 'Disabled'], ['notconfigured', 'Not configured']] as const) {
    const b = h('button', { type: 'button', textContent: label });
    b.dataset.state = id;
    b.addEventListener('click', () => { state = id; render(); });
    stateRow.append(b);
  }
  const fields = p.schema.elements.map((e) => input(e, () => render()));
  const fieldBox = h('div', { class: 'admx-fields' }, ...fields.map((f) => f.node));
  const out = h('div', { class: 'admx-out' });
  const err = h('p', { class: 'read-error hidden' });
  const actions = h('div', { class: 'script-actions' });
  const mk = (label: string, fn: () => void) => { const b = h('button', { type: 'button', class: 'btn', textContent: label }); b.addEventListener('click', fn); actions.append(b); return b; };
  mk('Download .reg', () => download(`${safeName(p.policy)}-${state}.reg`, toReg(last)));
  mk('Download apply script', () => download(`Set-${safeName(p.policy)}.ps1`, toPowerShellApply(last, `${p.displayName}: ${state}`)));
  mk('Download check script', () => download(`Test-${safeName(p.policy)}.ps1`, toPowerShellCheck(last, `${p.displayName}: ${state}`)));
  const add = mk('Add to my baseline', () => {
    const items = readBasket().filter((i) => !(i.file === p.file && i.policy === p.policy && i.cls === cls));
    items.push({ file: p.file, policy: p.policy, displayName: p.displayName, cls, state, values: readValues(), settings: last, addedAt: new Date().toISOString() });
    writeBasket(items);
    add.textContent = 'Added to your baseline';
    setTimeout(() => { add.textContent = 'Add to my baseline'; }, 1800);
  });
  add.classList.add('btn-primary');

  host.append(
    ...(p.classes.length > 1 ? [h('div', { class: 'admx-row' }, h('span', { class: 'admx-row-label', textContent: 'Where' }), clsRow)] : []),
    h('div', { class: 'admx-row' }, h('span', { class: 'admx-row-label', textContent: 'State' }), stateRow),
    fieldBox, err, out, actions,
    h('p', { class: 'dim admx-note', textContent: 'Your baseline lives in this browser only. Open it at /admx/baseline/ to export everything you added at once.' }),
  );

  function readValues(): ElementValues {
    const v: ElementValues = {};
    p.schema.elements.forEach((e, i) => { const x = fields[i].read(); if (x !== undefined) v[e.id] = x; });
    return v;
  }

  function render() {
    for (const b of clsRow.querySelectorAll('button')) b.classList.toggle('is-on', b.textContent === (cls === 'user' ? 'User' : 'Computer'));
    for (const b of stateRow.querySelectorAll('button')) b.classList.toggle('is-on', (b as HTMLButtonElement).dataset.state === state);
    fieldBox.hidden = state !== 'enabled' || fields.length === 0;
    try {
      const r = materialize(cls, p.registryKey, p.valueName, p.displayName, p.schema, state, readValues());
      last = r.settings;
      err.classList.add('hidden');
      out.replaceChildren(writesTable(r.settings), ...r.notes.map((n) => h('p', { class: 'dim admx-note', textContent: n })));
      for (const b of actions.querySelectorAll('button')) (b as HTMLButtonElement).disabled = false;
    } catch (e) {
      last = [];
      err.textContent = e instanceof AdmxMaterializeError ? e.message : 'Could not work out the writes for that choice.';
      err.classList.remove('hidden');
      out.replaceChildren();
      for (const b of actions.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
    }
  }
  render();
}

const KIND: Record<string, string> = { dword: 'REG_DWORD', qword: 'REG_QWORD', string: 'REG_SZ', expand: 'REG_EXPAND_SZ', multi: 'REG_MULTI_SZ' };
export function writesTable(settings: PolicySetting[]): HTMLElement {
  const tb = h('tbody');
  for (const s of settings) {
    const tr = h('tr', { class: s.absent ? 'is-absent' : '' });
    tr.append(
      h('td', {}, h('code', { textContent: `${s.scope === 'user' ? 'HKCU' : 'HKLM'}\\${s.path}` })),
      h('td', {}, h('code', { textContent: s.name })),
      h('td', {}, ...(s.absent ? [h('span', { class: 'dim', textContent: 'value removed' })]
        : [h('code', { textContent: s.kind === 'multi' ? (s.value ?? '').split('\n').join(' | ') : s.value ?? '' }), ' ', h('span', { class: 'dim', textContent: KIND[s.kind] ?? s.kind })])),
    );
    tb.append(tr);
  }
  return h('table', { class: 'tbl admx-writes' }, tb);
}
