// Code outline: the declarations of a file or folder — types with their fields,
// enums with their variants, functions and methods — parsed with tree-sitter,
// so an agent sees a module's shape in one call instead of reading it all.
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { listCode } from './sources.ts';

const GRAMMAR: Record<string, string> = {
  '.rs': 'rust', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.cs': 'c_sharp', '.rb': 'ruby', '.php': 'php',
  '.scala': 'scala', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.vue': 'vue', '.lua': 'lua', '.zig': 'zig',
};

// Node types across the grammars that declare something a model can use.
const DECL = new Set(`struct_item enum_item enum_variant field_declaration function_item function_signature_item impl_item trait_item mod_item type_item const_item macro_definition
class_declaration abstract_class_declaration interface_declaration type_alias_declaration enum_declaration function_declaration method_definition public_field_definition
property_signature method_signature enum_assignment class_definition function_definition protocol_declaration property_declaration enum_entry object_declaration
method_declaration type_spec record_declaration constructor_declaration enum_constant class method singleton_method module lexical_declaration export_statement`.split(/\s+/));
// Bodies hold logic, not declarations; a declaration's first line is enough of it.
const BODY = new Set('block statement_block function_body compound_statement arguments lexical_declaration'.split(' '));

const wasmDir = join(createRequire(import.meta.url).resolve('tree-sitter-wasms/package.json'), '../out');
let init: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
async function parser(grammar: string): Promise<Parser> {
  await (init ??= Parser.init());
  if (!languages.has(grammar)) languages.set(grammar, Language.load(join(wasmDir, `tree-sitter-${grammar}.wasm`)));
  const p = new Parser();
  p.setLanguage(await languages.get(grammar)!);
  return p;
}

// An attribute or decorator that serves the function as an HTTP route (utoipa, actix, rocket, Spring, NestJS, Flask, FastAPI).
const ROUTE = /^\s*(#\[(utoipa::path|get|post|put|patch|delete)\b|@(\w+\.)?(route|get|post|put|patch|delete|(Get|Post|Put|Patch|Delete|Request)(Mapping)?)\()/i;

const firstLine = (s: string, max = 140) => s.split('\n')[0].trim().slice(0, max);

// SQL schema: each CREATE TABLE as a `table` with its columns, and each CHECK (col IN (...)) as an enum
// `<table>.<col>` with its values — the stored shape of a product's entities and the states they allow.
// shortcut: CREATE TABLE only; columns and checks added later by ALTER TABLE are left out — parse those when a project needs them.
export function outlineSql(text: string): string[] {
  const out: string[] = [];
  const row = (at: number) => text.slice(0, at).split('\n').length;
  for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)["`]?\s*\(/gi)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth) depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0, end++;
    const body = text.slice(start, end - 1);
    out.push(`${row(m.index)}: table ${m[1]}`);
    const checks: string[] = [];
    // Top-level items of the body: columns, and constraints that aren't columns.
    let d = 0;
    let from = 0;
    for (let i = 0; i <= body.length; i++) {
      const c = body[i];
      if (c === '(') d++;
      else if (c === ')') d--;
      else if ((c === ',' && !d) || i === body.length) {
        const item = body.slice(from, i);
        const lead = item.length - item.trimStart().length;
        const col = /^["`]?(\w+)["`]?\s+(\w+)/.exec(item.trim());
        if (col && !/^(constraint|primary|unique|check|foreign|exclude|key|index)$/i.test(col[1])) out.push(`${row(start + from + lead)}:   ${col[1]}: ${item.trim().split('\n')[0].slice(col[1].length).trim().slice(0, 100)}`);
        for (const k of item.matchAll(/check\s*\(\s*["`]?(\w+)["`]?\s+in\s*\(([^)]*)\)/gi)) {
          const values = [...k[2].matchAll(/'([^']*)'/g)].map((v) => v[1]);
          if (values.length) checks.push(`${row(start + from + (k.index ?? 0))}: enum ${m[1]}.${k[1]}`, ...values.map((v) => `${row(start + from + (k.index ?? 0))}:   ${v}`));
        }
        from = i + 1;
      }
    }
    out.push(...checks);
  }
  return out;
}

export async function outlineText(text: string, file: string): Promise<string[] | undefined> {
  if (extname(file).toLowerCase() === '.sql') return outlineSql(text);
  const grammar = GRAMMAR[extname(file).toLowerCase()];
  if (!grammar) return undefined;
  const p = await parser(grammar);
  const tree = p.parse(text);
  if (!tree) return undefined;
  const out: string[] = [];
  const walk = (n: Node, depth: number) => {
    let next = depth;
    // export_statement wraps the declaration it exports: show the declaration once.
    if (DECL.has(n.type) && !(n.type === 'export_statement' && n.namedChildren.some((c) => c && DECL.has(c.type)))) {
      // A doc comment right above says what the declaration means: its first line, of a block of line comments too.
      let c = n.previousNamedSibling;
      let top: Node | null = null;
      let route = false;
      // Attributes and decorators (#[derive], @Entity) may sit between the comment and the declaration.
      for (let row = n.startPosition.row; c && /comment|attribute|decorator|annotation/.test(c.type) && c.endPosition.row >= row - 1; row = c.startPosition.row, c = c.previousNamedSibling)
        if (c.type.includes('comment')) top = c;
        else route ||= ROUTE.test(c.text);
      const doc = top ? `  ${firstLine(top.text, 100)}` : '';
      route ||= ROUTE.test(firstLine(n.text));
      out.push(`${n.startPosition.row + 1}: ${'  '.repeat(depth)}${route ? '[route] ' : ''}${firstLine(n.text)}${doc}`);
      next = depth + 1;
    }
    if (BODY.has(n.type) && depth > 0) return;
    for (const c of n.namedChildren) if (c) walk(c, next);
  };
  walk(tree.rootNode, 0);
  tree.delete();
  p.delete();
  return out;
}

// Outlines a file, or every file of a known language under a folder, up to `max` characters.
export async function outlineCode(root: string, path: string, max = 40_000): Promise<string> {
  const files = (await stat(join(root, path)).catch(() => undefined))?.isFile() ? [path] : await listCode(root, undefined, path);
  const parts: string[] = [];
  let size = 0;
  let skipped = 0;
  for (const f of files) {
    const sql = extname(f).toLowerCase() === '.sql';
    // Numbered migrations in a programming language replay history; SQL ones are where the schema is.
    if ((!GRAMMAR[extname(f).toLowerCase()] && !sql) || /(^|\/)(tests?|__tests__|spec|fixtures?)\/|\.(test|spec)\.|_test\.go$/.test(f) || (!sql && /(^|\/)migrations?\/\d/.test(f))) continue;
    const abs = join(root, f);
    if ((await stat(abs)).size > 512 * 1024) continue;
    const lines = await outlineText(await readFile(abs, 'utf8'), f);
    if (!lines?.length) continue;
    const part = `## ${f}\n${lines.join('\n')}`;
    if (size + part.length > max) {
      skipped++;
      continue;
    }
    parts.push(part);
    size += part.length;
  }
  if (!parts.length) return `No declarations in a known language under “${path || '.'}”`;
  return parts.join('\n\n') + (skipped ? `\n\n… ${skipped} more files left out — outline a narrower folder` : '');
}

// The name a declaration line declares: `pub struct Task {` → Task, `  pub due_date: Option<Day>` → due_date, `  Inbox` → Inbox.
export const declared = (line: string) =>
  /\b(?:struct|enum|class|interface|type|trait|protocol|record|object|table)\s+([\w.]+)/.exec(line)?.[1]?.replace(/\.$/, '') ??
  (/\b(?:fn|function|def|func)\s/.test(line) ? undefined : /^(?:pub(?:\([^)]*\))?\s+|readonly\s+|(?:let|var|val|const)\s+)*(\w+)\s*(?:[:=(,{]|$)/.exec(line.trim())?.[1]);

// What of an outline the model doesn't cover yet: types none of whose names the model has, the fields and
// variants of the other types it lacks, and route handlers no action explains. Other functions are left out.
export function uncovered(outline: string, covered: (name: string) => boolean, routeCovered: (name: string) => boolean = covered): string {
  const out: string[] = [];
  for (const part of outline.split(/\n\n(?=## )/)) {
    const [head, ...lines] = part.split('\n');
    const keep: string[] = [];
    let type: { line: string; covered: boolean; members: string[] } | undefined;
    const flush = () => {
      if (type && (!type.covered || type.members.length)) keep.push(type.line, ...type.members);
      type = undefined;
    };
    for (const line of lines) {
      const top = /^\d+: \S/.test(line);
      const name = declared(line.replace(/^\d+:\s*/, ''));
      const handler = /\[route\][^\n]*?\b(?:fn|function|def|func)\s+(\w+)/.exec(line)?.[1] ?? (/\[route\]/.test(line) ? /(\w+)\s*\(/.exec(line.replace(/^.*?\)\s*/, ''))?.[1] : undefined);
      if (handler) {
        if (top) flush();
        if (!routeCovered(handler)) keep.push(line.trimEnd());
        continue;
      }
      if (top) {
        flush();
        if (name && /\b(struct|enum|class|interface|type|trait|protocol|record|object|table)\s/.test(line)) type = { line, covered: covered(name), members: [] };
      } else if (type && name && !/\b(fn|function|def|func)\s/.test(line) && !covered(name)) type.members.push(line);
    }
    flush();
    if (keep.length) out.push([head, ...keep].join('\n'));
  }
  return out.join('\n\n');
}

// The fields or variants of one type in a file: name, the declaration line and its line number.
export async function members(text: string, file: string, type: string): Promise<{ name: string; line: string; row: number }[]> {
  const lines = (await outlineText(text, file)) ?? [];
  const at = lines.findIndex((l) => /^\d+: \S/.test(l) && declared(l.replace(/^\d+:\s*/, '').replace('[route] ', '')) === type);
  if (at < 0) return [];
  const out: { name: string; line: string; row: number }[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^\d+:   \S/.test(l)) {
      if (/^\d+: \S/.test(l)) break;
      continue;
    }
    const decl = l.replace(/^\d+:\s*/, '').replace(/ {2}(\/\/|\/\*|#).*$/, '');
    const name = /\b(fn|function|def|func)\s/.test(decl) ? undefined : declared(decl);
    if (name) out.push({ name, line: decl, row: Number(l.split(':')[0]) });
  }
  return out;
}

// The types an outline declares, with their file: `struct Task` → { file, name: 'Task', enum: false }.
export function typesIn(outline: string): { file: string; name: string; enum: boolean }[] {
  return outline.split(/\n\n(?=## )/).flatMap((part) => {
    const [head, ...lines] = part.split('\n');
    const file = head.replace(/^## /, '');
    return lines.flatMap((l) => {
      const m = /^\d+: (?:\[route\] )?.*?\b(struct|enum|class|interface|type|record|table)\s+([\w.]+)/.exec(l);
      return m ? [{ file, name: m[2], enum: m[1] === 'enum' }] : [];
    });
  });
}
