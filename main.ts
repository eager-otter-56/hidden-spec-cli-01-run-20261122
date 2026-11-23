// mend — a command-line tool that applies an edit an AI model wrote to a tree of text files.
//
// The patch may be written in any of four formats: a unified diff (its line numbers may be wrong),
// a set of SEARCH/REPLACE blocks, a V4A patch, or a list of text-editor tool calls as JSON. mend
// reads the patch, finds the lines each edit names (at the first of three matching tiers that has
// them, so drifted whitespace and indentation are tolerated), and changes every file the patch
// names or none of them: a failed edit anywhere means nothing is written.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// With no PATCH (or PATCH `-`) the patch is read from standard input. `--check` reports what would
// change without writing; `--strict` matches lines exactly. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A line to print on standard output with exit code 2 (usage, no-patch, format and parse errors). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a failure code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at `\n`, one trailing `\r` removed from each, no piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is relative, non-empty, and no segment of it is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------- files

/** A file as lines: its own line break, the lines themselves, and whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    lines.pop();
    eol = true;
  }
  return { lines, br, eol };
}

function serialize(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

// ---------------------------------------------------------------- matching lines

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

/** Whether file line `a` equals patch line `b` at a tier: 0 exact, 1 trailing-trimmed, 2 fully trimmed. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/**
 * Find the lines O in a file's lines, at or after `from`: the first tier (0 only when strict) at
 * which O occurs at least once there, with every occurrence position at that tier.
 */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!lineEq(lines[i + k]!, O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: its kind, its text, and whether it was an empty patch line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

/** The old lines O of a body: its context and `-` lines, in order. */
function oldLines(entries: BodyLine[]): string[] {
  return entries.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
}

/**
 * The lines that replace a match of O at `pos`: context lines are the file's own matched lines;
 * `+` lines are the patch's, re-indented at tier 2 (the first matched line's leading whitespace in
 * the file replaces the first old line's, on every line that carries it).
 */
function replacement(lines: string[], pos: number, entries: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let F = '';
  let P = '';
  if (tier === 2) {
    F = leadWs(lines[pos]!);
    const first = entries.find((e) => e.kind === ' ' || e.kind === '-');
    P = first ? leadWs(first.text) : '';
  }
  for (const e of entries) {
    if (e.kind === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (e.kind === '-') {
      oi += 1;
    } else if (e.kind === '+') {
      let t = e.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (so the result has no final break). */
function backslashAfter(entries: BodyLine[]): boolean {
  for (let j = entries.length - 1; j >= 0; j -= 1) {
    const k = entries[j]!.kind;
    if (k === ' ' || k === '+') return entries[j + 1]?.kind === '\\';
  }
  return false;
}

// ---------------------------------------------------------------- the tree

/** A move an edit made: [old path, new path], for the `R` line of the report. */
type Move = readonly [string, string];

/** One edit of a patch: it reads and changes the tree, or throws Fail; it records any move it makes. */
type EditFn = (tree: Tree, moves: Move[]) => void;

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** The file an edit works on, or the edit fails: safety first, then existence. */
function needFile(tree: Tree, p: string): string {
  if (!safe(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---------------------------------------------------------------- unified diffs

interface Hunk {
  a: number;
  entries: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hasPair: boolean;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or a parse error when the line is not of that form. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

/** A `---`/`+++` path: up to the first tab, spaces removed, `/dev/null` is no file, a leading `a/` or `b/` removed. */
function headerPath(raw: string): string | null {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^ +| +$/g, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** A hunk header's old start A, or null when the line is not `@@ -A[,B] +C[,D] @@` plus optional text. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) return null;
  return parseInt(m[1]!, 10);
}

/** A hunk's body from line `start`: lines starting with ` `, `-`, `+` or `\`, and empty lines (empty context). */
function hunkBody(lines: string[], start: number): { entries: BodyLine[]; next: number } {
  const entries: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') entries.push({ kind: ' ', text: '', empty: true });
    else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') entries.push({ kind: l[0], text: l.slice(1), empty: false });
    else break;
    j += 1;
  }
  while (entries.length > 0 && entries[entries.length - 1]!.empty) entries.pop();
  return { entries, next: j };
}

/** Apply a section's hunks in order to a file model; a hunk that finds nothing fails the section. */
function applyHunks(model: FileModel, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const O = oldLines(h.entries);
    const nLen = h.entries.filter((e) => e.kind === ' ' || e.kind === '+').length;
    if (O.length > 0) {
      const found = findTier(model.lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const atEnd = pos + O.length === model.lines.length;
      const repl = replacement(model.lines, pos, h.entries, found.tier);
      model.lines.splice(pos, O.length, ...repl);
      if (atEnd) model.eol = !backslashAfter(h.entries);
    } else {
      const pos = Math.min(h.a + d, model.lines.length);
      const adds = h.entries.filter((e) => e.kind === '+').map((e) => e.text);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...adds);
      if (atEnd) model.eol = !backslashAfter(h.entries);
    }
    d += nLen - O.length;
  }
}

/** The one edit a unified section makes, from its resolved paths and kind. */
function sectionEdit(s: Section, strict: boolean): EditFn {
  const oldP = s.hasPair ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitOld;
  const newP = s.hasPair ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitNew;
  if (oldP === null || s.newFile) {
    const target = (newP ?? oldP) as string;
    return (tree) => {
      if (target === undefined || target === null || !safe(target)) throw new Fail('unsafe', String(target ?? ''));
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const all: string[] = [];
      for (const h of s.hunks) for (const e of h.entries) if (e.kind === '+') all.push(e.text);
      let noBreak = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const es = s.hunks[hi]!.entries;
        for (let j = es.length - 1; j >= 0; j -= 1) {
          if (es[j]!.kind === '+') {
            noBreak = es[j + 1]?.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(target, all.length === 0 ? '' : all.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (newP === null || s.delFile) {
    const target = oldP as string;
    return (tree) => {
      if (target === undefined || !safe(target)) throw new Fail('unsafe', String(target ?? ''));
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== undefined && newP !== undefined && oldP !== newP) {
    const from = oldP;
    const to = newP;
    return (tree, moves) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const model = parseFile(before);
      applyHunks(model, s.hunks, from, strict);
      tree.now.set(to, serialize(model));
      tree.now.set(from, null);
      moves.push([from, to]);
    };
  }
  const path = (oldP ?? newP) as string;
  return (tree) => {
    const before = needFile(tree, path);
    const model = parseFile(before);
    applyHunks(model, s.hunks, path, strict);
    tree.now.set(path, serialize(model));
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ hasPair: false, newFile: false, delFile: false, hunks: [], inHeader: true });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      if (cur !== null) sections.push(cur);
      cur = fresh();
      cur.gitOld = x;
      cur.gitNew = y;
      i += 1;
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkStart(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = hunkBody(lines, i + 1);
      cur.hunks.push({ a, entries: body.entries });
      cur.inHeader = false;
      i = body.next;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const po = headerPath(line.slice(4));
      const pn = headerPath(lines[i + 1]!.slice(4));
      if (cur !== null && cur.inHeader && !cur.hasPair) {
        cur.pairOld = po;
        cur.pairNew = pn;
        cur.hasPair = true;
      } else {
        if (cur !== null) sections.push(cur);
        cur = fresh();
        cur.pairOld = po;
        cur.pairNew = pn;
        cur.hasPair = true;
      }
      i += 2;
    } else if (line.startsWith('--- ') && cur !== null && cur.inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    } else if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | undefined;
  let from = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | undefined;
    for (let j = s - 1; j >= from; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    const O = lines.slice(s + 1, eq);
    const N = lines.slice(eq + 1, rp);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, N.length === 0 ? '' : N.join('\n') + '\n');
        return;
      }
      const model = parseFile(needFile(tree, p));
      const found = findTier(model.lines, O, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const entries: BodyLine[] = [
        ...O.map((t) => ({ kind: '-' as const, text: t, empty: false })),
        ...N.map((t) => ({ kind: '+' as const, text: t, empty: false })),
      ];
      const repl = replacement(model.lines, pos, entries, found.tier);
      model.lines.splice(pos, O.length, ...repl);
      tree.now.set(p, serialize(model));
    });
    prevPath = path;
    i = rp + 1;
    from = rp + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches

interface Chunk {
  anchor?: string;
  eof: boolean;
  entries: BodyLine[];
}

const v4aHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4A(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: { line: string; num: number }[] = [];
      let j = i + 1;
      while (j < last && !v4aHeader(lines[j]!)) {
        raw.push({ line: lines[j]!, num: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      const texts: string[] = [];
      for (const { line: l, num } of raw) {
        if (l.startsWith('+')) texts.push(l.slice(1));
        else if (l === '') texts.push('');
        else throw new Exit2(`error: parse ${num}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, texts.length === 0 ? '' : texts.join('\n') + '\n');
      });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !v4aHeader(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      let j = i + 1;
      let moveTo: string | undefined;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const raw: { line: string; num: number }[] = [];
      while (j < last && !v4aHeader(lines[j]!)) {
        raw.push({ line: lines[j]!, num: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let firstChunk = true;
      for (const { line: l, num } of raw) {
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? undefined : anchor, eof: false, entries: [] };
          chunks.push(cur);
          firstChunk = false;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${num}`);
            cur = { eof: false, entries: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          cur.entries.push({ kind: l === '' ? ' ' : (l[0] as BodyLine['kind']), text: l === '' ? '' : l.slice(1), empty: l === '' });
        } else {
          throw new Exit2(`error: parse ${num}`);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updLine}`);
      const to = moveTo;
      edits.push((tree, moves) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (to !== undefined && !safe(to)) throw new Fail('unsafe', to);
        const model = parseFile(needFile(tree, p));
        if (to !== undefined && tree.get(to) !== null) throw new Fail('exists', to);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== undefined) {
            const f = findTier(model.lines, [ch.anchor], strict, cursor);
            if (f === null) throw new Fail('no-match', p);
            cursor = f.positions[0]! + 1;
          }
          const O = oldLines(ch.entries);
          if (O.length > 0) {
            const f = findTier(model.lines, O, strict, cursor);
            if (f === null) throw new Fail('no-match', p);
            const positions = ch.eof ? f.positions.filter((q) => q + O.length === model.lines.length) : f.positions;
            if (positions.length === 0) throw new Fail('no-match', p);
            const pos = positions[0]!;
            const repl = replacement(model.lines, pos, ch.entries, f.tier);
            model.lines.splice(pos, O.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const adds = ch.entries.filter((e) => e.kind === '+').map((e) => e.text);
            const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
            model.lines.splice(pos, 0, ...adds);
            cursor = pos + adds.length;
          }
        }
        if (to !== undefined) {
          tree.now.set(to, serialize(model));
          tree.now.set(p, null);
          moves.push([p, to]);
        } else {
          tree.now.set(p, serialize(model));
        }
      });
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ---------------------------------------------------------------- JSON edits

/** One JSON edit object, as an edit, or null when it is not a valid one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const model = parseFile(needFile(tree, p));
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(model));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- detecting the format

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- the command line

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const made: Move[] = [];
    try {
      edit(tree, made);
      moves.push(...made);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      consumed.add(o);
      consumed.add(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
