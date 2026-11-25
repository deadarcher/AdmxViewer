// A small XML reader for ADMX/ADML. Pure TypeScript, no DOM: the same code runs in the browser (a visitor's own
// files), in Node (tests, the catalog generator) and in the Cloudflare Worker, so the three can never disagree the
// way DOMParser implementations do.
//
// Handles what ADMX and ADML use: elements, attributes, text, comments, CDATA, processing instructions, the five
// named entities and numeric character references. A DOCTYPE is refused outright, the same rule as the C#
// AdmxParser's DtdProcessing.Prohibit (no entity expansion, no external resolution: uploaded XML is untrusted).

export type XEl = { name: string; attrs: Record<string, string>; children: XEl[]; text: string };

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

const local = (qname: string) => { const i = qname.indexOf(':'); return i < 0 ? qname : qname.slice(i + 1); };

export class XmlError extends Error {}

/** Parses a document and returns its root element. Element and attribute names are LOCAL names (no prefix), as the
 *  C# parser compares them (LocalName). Text is the concatenated character data of the element itself; use
 *  innerText() for the XDocument .Value equivalent (all descendant text). */
export function parseXml(xml: string): XEl {
  let s = xml;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // XML 1.0 section 2.11, as .NET's XmlReader applies it: CRLF and a lone CR become LF before anything is read.
  s = s.replace(/\r\n?/g, '\n');
  const stack: XEl[] = [];
  let root: XEl | null = null;
  let i = 0;
  const n = s.length;
  const textOf = (el: XEl, t: string) => { el.text += t; };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      const tail = s.slice(i);
      if (stack.length && tail) textOf(stack[stack.length - 1], decode(tail));
      else if (tail.trim()) throw new XmlError('text after the root element');
      break;
    }
    if (lt > i && stack.length) textOf(stack[stack.length - 1], decode(s.slice(i, lt)));
    else if (lt > i && s.slice(i, lt).trim()) throw new XmlError('text outside the root element');
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('unterminated comment');
      i = end + 3; continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('unterminated CDATA');
      if (stack.length) textOf(stack[stack.length - 1], s.slice(lt + 9, end));
      i = end + 3; continue;
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('unterminated processing instruction');
      i = end + 2; continue;
    }
    if (s.startsWith('<!', lt)) throw new XmlError('DTDs are not allowed in ADMX/ADML');
    if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt + 2);
      if (end < 0) throw new XmlError('unterminated end tag');
      const name = local(s.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`mismatched end tag </${name}>`);
      i = end + 1; continue;
    }
    // Start tag: name, then attributes, then > or />.
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(s[j])) j++;
    const el: XEl = { name: local(s.slice(lt + 1, j)), attrs: {}, children: [], text: '' };
    if (!el.name) throw new XmlError('empty tag name');
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(s[j])) j++;
      if (j >= n) throw new XmlError('unterminated start tag');
      if (s[j] === '>') { j++; break; }
      if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(s[k])) k++;
      const an = s.slice(j, k);
      while (k < n && /\s/.test(s[k])) k++;
      if (s[k] !== '=') throw new XmlError(`attribute ${an} has no value`);
      k++;
      while (k < n && /\s/.test(s[k])) k++;
      const q = s[k];
      if (q !== '"' && q !== "'") throw new XmlError(`attribute ${an} is not quoted`);
      const close = s.indexOf(q, k + 1);
      if (close < 0) throw new XmlError('unterminated attribute value');
      // xmlns declarations are not attributes the parser reads; the C# side ignores them too (Attribute(name)).
      // Attribute-value normalization (XML 1.0 section 3.3.3): literal tab/newline become spaces BEFORE character
      // references are expanded, so "&#10;" still yields a newline.
      if (an !== 'xmlns' && !an.startsWith('xmlns:')) el.attrs[local(an)] = decode(s.slice(k + 1, close).replace(/[\t\n]/g, ' '));
      j = close + 1;
    }
    if (stack.length) stack[stack.length - 1].children.push(el);
    else if (root) throw new XmlError('more than one root element');
    else root = el;
    if (!selfClose) stack.push(el);
    i = j;
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new XmlError('no root element');
  return root;
}

/** XElement.Value for the elements the parser reads it from (stringTable strings, presentation controls, label,
 *  defaultValue, ADMX string values): those hold character data only. An element WITH child elements would need
 *  document-order interleaving, which this reader does not track; the parity check against the C# parser over a
 *  full PolicyDefinitions folder is what proves the assumption holds. */
export function innerText(el: XEl): string {
  return el.text + el.children.map(innerText).join('');
}

/** File bytes -> text the way .NET's File.ReadAllText does it: a byte-order mark decides (UTF-8, UTF-16 LE/BE), no
 *  mark means UTF-8. Windows ships some ADMX as UTF-16 (Search.admx); read as UTF-8 it is garbage. */
export function decodeXmlBytes(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  return new TextDecoder('utf-8').decode(b);
}

export const kids =(el: XEl, name: string) => el.children.filter((c) => c.name === name);
export const kid = (el: XEl, name: string): XEl | undefined => el.children.find((c) => c.name === name);
export const attr = (el: XEl, name: string): string | undefined => el.attrs[name];
