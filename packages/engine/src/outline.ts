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

const firstLine = (s: string, max = 140) => s.split('\n')[0].trim().slice(0, max);

export async function outlineText(text: string, file: string): Promise<string[] | undefined> {
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
      // Attributes and decorators (#[derive], @Entity) may sit between the comment and the declaration.
      for (let row = n.startPosition.row; c && /comment|attribute|decorator|annotation/.test(c.type) && c.endPosition.row >= row - 1; row = c.startPosition.row, c = c.previousNamedSibling)
        if (c.type.includes('comment')) top = c;
      const doc = top ? `  ${firstLine(top.text, 100)}` : '';
      out.push(`${n.startPosition.row + 1}: ${'  '.repeat(depth)}${firstLine(n.text)}${doc}`);
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
    if (!GRAMMAR[extname(f).toLowerCase()] || /(^|\/)(tests?|__tests__|spec|fixtures?|migrations?\/\d)|\.(test|spec)\.|_test\.go$/.test(f)) continue;
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
