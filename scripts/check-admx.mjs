/**
 * The ADMX engine on getrff.com is a port of RFF's C# AdmxParser + AdmxMaterializer, the code behind RFF's Settings
 * Catalog and Conformance. A port that drifts is worse than none: the site would tell an admin a policy writes one
 * thing while RFF enforces another. So this compares the two on REAL files, field by field and write by write.
 *
 * Golden = what the C# code produced for a PolicyDefinitions folder (RFF.Api.Tests AdmxParityGoldenTests, run with
 * RFF_ADMX_GOLDEN_IN / RFF_ADMX_GOLDEN_OUT). scripts/fixtures/admx holds a committed subset (CI); pass a folder and
 * its golden to compare a full set locally.
 *
 * Run: node scripts/check-admx.mjs [policyDefinitionsDir goldenDir]
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(tmpdir(), 'rff-admx-check.mjs');
// esbuild's JS API: node_modules/esbuild/bin/esbuild is the native binary on Linux (guard rule 19).
buildSync({ entryPoints: [join(root, 'src/lib/admx/_admxTestBarrel.ts')], bundle: true, format: 'esm',
  platform: 'node', logLevel: 'warning', outfile: bundle, absWorkingDir: root });
const { parseBatch, materialize, AdmxMaterializeError, parseXml, XmlError, decodeXmlBytes } = await import(pathToFileURL(bundle).href + '?t=' + Date.now());

let fails = 0;
const check = (name, cond, detail = '') => { if (!cond || process.env.VERBOSE) console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`); if (!cond) fails++; };

/** JSON as C# writes it (nulls omitted) vs our objects (undefined omitted): normalize both the same way. */
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x === null ? undefined : x)));
function firstDiff(a, b, path = '') {
  if (typeof a !== typeof b) return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  if (a && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

function compare(label, dir, goldenDir) {
  console.log(`== ${label}: ${dir} ==`);
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.admx'))
    .sort((a, b) => { const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; })   // C# StringComparer.OrdinalIgnoreCase
    .map((f) => {
      // Case-insensitive, as the C# side gets from Windows: Dell ships "Dell Command Update.ADMX". Matched by listing
      // the folder, because this also runs on Linux (Cloudflare's build), where the file system is case-sensitive.
      const want = f.replace(/\.admx$/i, '').toLowerCase() + '.adml';
      const hit = existsSync(join(dir, 'en-US')) ? readdirSync(join(dir, 'en-US')).find((n) => n.toLowerCase() === want) : undefined;
      const adml = join(dir, 'en-US', hit ?? want);
      return { fileName: f, admxXml: decodeXmlBytes(readFileSync(join(dir, f))), admlXml: existsSync(adml) ? decodeXmlBytes(readFileSync(adml)) : null };
    });
  const t0 = Date.now();
  const ours = parseBatch(files);
  const ms = Date.now() - t0;
  const gold = JSON.parse(readFileSync(join(goldenDir, 'parse.json'), 'utf8'));
  check(`${label}: same number of files`, ours.length === gold.length, `${ours.length} vs ${gold.length}`);
  let settings = 0, diffs = 0;
  for (let i = 0; i < Math.min(ours.length, gold.length); i++) {
    const o = norm(ours[i]), g = norm(gold[i]);
    // Parse-failure messages come from different XML libraries; compare that a failure happened, not its words.
    const fail = (w) => w.map((x) => (/^failed to parse:|ADML parse failed/.test(x) ? x.replace(/:.*/s, ':') : x));
    o.warnings = fail(o.warnings ?? []); g.warnings = fail(g.warnings ?? []);
    const d = firstDiff(o, g);
    settings += (g.settings ?? []).length;
    if (d) { diffs++; if (diffs <= 5) check(`${label}: ${g.fileName} parses the same`, false, d); }
  }
  check(`${label}: every file parses the same as RFF (${settings} settings, ${ms} ms)`, diffs === 0, `${diffs} file(s) differ`);

  const goldMat = JSON.parse(readFileSync(join(goldenDir, 'materialize.json'), 'utf8'));
  let mi = 0, mdiff = 0;
  for (const src of ours)
    for (const s of src.settings)
      for (const state of ['enabled', 'disabled', 'notconfigured']) {
        const g = goldMat[mi++];
        let o;
        try {
          const r = materialize(s.class, s.registryKey, s.valueName, s.displayName, s.schema, state, undefined);
          o = { file: src.fileName, policy: s.policyName, cls: s.class, state, settings: r.settings, notes: r.notes };
        } catch (e) {
          if (!(e instanceof AdmxMaterializeError)) throw e;
          o = { file: src.fileName, policy: s.policyName, cls: s.class, state, error: e.message };
        }
        const d = firstDiff(norm(o), norm(g ?? {}));
        if (d) { mdiff++; if (mdiff <= 5) check(`${label}: ${src.fileName} ${s.policyName} ${s.class} ${state} writes the same`, false, d); }
      }
  check(`${label}: every policy x state writes the same as RFF (${mi} cases)`, mdiff === 0 && mi === goldMat.length, `${mdiff} differ, ${mi} vs ${goldMat.length} cases`);
}

const fx = join(root, 'scripts', 'fixtures', 'admx');
if (existsSync(join(fx, 'PolicyDefinitions'))) compare('fixture subset', join(fx, 'PolicyDefinitions'), join(fx, 'golden'));
if (process.argv[2] && process.argv[3]) compare('full folder', process.argv[2], process.argv[3]);

console.log('== XML safety ==');
let threw = false;
try { parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'); } catch (e) { threw = e instanceof XmlError; }
check('a DTD is refused (no entity expansion)', threw);
const r = parseBatch([{ fileName: 'evil.admx', admxXml: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///c:/windows/win.ini">]><policyDefinitions/>', admlXml: null }]);
check('a DTD in an uploaded ADMX fails that file, not the batch', r.length === 1 && r[0].settings.length === 0 && /failed to parse/.test(r[0].warnings[0]));

console.log(`\n${fails ? fails + ' failure(s)' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
