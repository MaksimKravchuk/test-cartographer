import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { Backlog, Entity, Project, Proposal, RunReport, Source, SourceRegistry, type ScenarioResult, type SourceKind } from './schema.ts';

// A workspace is a plain folder that is easy to keep in git:
//   cartographer.yaml     project: interfaces, roles, MCP, agent runtime, agents
//   entities/*.yaml       entity models
//   entities/*.layout.json  graph node positions (separate, to keep diffs quiet)
//   sources.yaml          registry of uploaded knowledge sources (onboarding)
//   sources/*             the source files themselves — docs, tracker exports, contracts, notes
//   backlog.yaml          epics/features/stories: a view over the model, not a second one
//   proposals/*.yaml      agent proposals and the decisions on them
//   actions/*.ts          action library for Playwright
//   evidence/             screenshots and snapshots collected by agents
//   generated/            compiled tests
//   runs/                 run reports
export class Workspace {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  path(...parts: string[]) {
    return join(this.root, ...parts);
  }

  async project(): Promise<Project> {
    return Project.parse(YAML.parse(await readFile(this.path('cartographer.yaml'), 'utf8')));
  }

  async entityIds(): Promise<string[]> {
    const files = await readdir(this.path('entities')).catch(() => []);
    return files.filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
  }

  async entityText(id: string): Promise<string> {
    return readFile(this.path('entities', `${id}.yaml`), 'utf8');
  }

  // Every entity of the project: needed to prepare related instances.
  async catalog(): Promise<Record<string, Entity>> {
    const ids = await this.entityIds();
    return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await this.entity(id)).entity] as const)));
  }

  async entity(id: string): Promise<{ entity: Entity; revision: string }> {
    const text = await this.entityText(id);
    return { entity: Entity.parse(YAML.parse(text)), revision: revision(text) };
  }

  // Saves the model if its revision hasn't changed since it was read.
  async saveEntity(entity: Entity, expectedRevision?: string): Promise<string> {
    const file = this.path('entities', `${entity.id}.yaml`);
    if (expectedRevision && existsSync(file)) {
      const current = revision(await readFile(file, 'utf8'));
      if (current !== expectedRevision)
        throw new RevisionConflict(`Model “${entity.id}” has changed (revision ${current}, expected ${expectedRevision})`);
    }
    await mkdir(this.path('entities'), { recursive: true });
    return revision(await writeChangedKeys(file, Entity.parse(entity), (v) => Entity.parse(v)));
  }

  // Removing an entity moves its files to entities/.trash, so nothing is lost by a misclick.
  async trashEntity(id: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(this.path('entities', '.trash'), { recursive: true });
    await rename(this.path('entities', `${id}.yaml`), this.path('entities', '.trash', `${id}-${stamp}.yaml`));
    if (existsSync(this.path('entities', `${id}.layout.json`)))
      await rename(this.path('entities', `${id}.layout.json`), this.path('entities', '.trash', `${id}-${stamp}.layout.json`));
  }

  // Comments and formatting on every key the save doesn't change survive (see writeChangedKeys).
  async saveProject(project: Project): Promise<void> {
    await writeChangedKeys(this.path('cartographer.yaml'), Project.parse(project), (v) => Project.parse(v));
  }

  // ── Knowledge sources ─────────────────────────────────────────────────
  async sources(): Promise<Source[]> {
    const text = await readFile(this.path('sources.yaml'), 'utf8').catch(() => null);
    return text === null ? [] : SourceRegistry.parse(YAML.parse(text)).sources;
  }

  async sourceText(id: string): Promise<string> {
    const source = (await this.sources()).find((s) => s.id === id);
    if (!source) throw new Error(`Unknown source “${id}”`);
    return readFile(this.path('sources', source.file), 'utf8');
  }

  async saveSources(sources: Source[]): Promise<void> {
    await mkdir(this.path('sources'), { recursive: true });
    await writeFile(this.path('sources.yaml'), toYaml(SourceRegistry.parse({ sources })));
  }

  // id = a kebab slug of the file name, made unique; file keeps the name's own
  // extension (.md if it has none). Text only — a tester uploads docs and
  // tracker exports, not binaries.
  async addSource(input: { name: string; content: string; kind?: SourceKind; title?: string }): Promise<Source> {
    if (input.content.includes('\0')) throw new Error(`“${input.name}” looks like a binary file — only text sources are supported`);
    if (Buffer.byteLength(input.content, 'utf8') > 2 * 1024 * 1024) throw new Error(`“${input.name}” is larger than 2 MB`);

    const existing = await this.sources();
    const ext = extname(input.name) || '.md';
    const slug = slugify(basename(input.name, extname(input.name)));
    let id = slug;
    for (let n = 2; existing.some((s) => s.id === id); n++) id = `${slug}-${n}`;

    const source = Source.parse({
      id,
      title: input.title ?? input.name,
      kind: input.kind ?? 'doc',
      file: `${id}${ext}`,
      addedAt: new Date().toISOString(),
    });
    await mkdir(this.path('sources'), { recursive: true });
    await writeFile(this.path('sources', source.file), input.content);
    await this.saveSources([...existing, source]);
    return source;
  }

  // Removing a source moves its file to sources/.trash, like trashEntity above.
  async removeSource(id: string): Promise<void> {
    const list = await this.sources();
    const source = list.find((s) => s.id === id);
    if (!source) throw new Error(`Unknown source “${id}”`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(this.path('sources', '.trash'), { recursive: true });
    await rename(this.path('sources', source.file), this.path('sources', '.trash', `${id}-${stamp}${extname(source.file)}`));
    await this.saveSources(list.filter((s) => s.id !== id));
  }

  // ── Backlog ───────────────────────────────────────────────────────────
  async backlog(): Promise<{ backlog: Backlog; revision: string }> {
    const text = await readFile(this.path('backlog.yaml'), 'utf8').catch(() => null);
    return text === null ? { backlog: Backlog.parse({}), revision: '' } : { backlog: Backlog.parse(YAML.parse(text)), revision: revision(text) };
  }

  // Same revision check as saveEntity: a revision only matters once a backlog.yaml exists.
  async saveBacklog(backlog: Backlog, expectedRevision?: string): Promise<string> {
    const file = this.path('backlog.yaml');
    if (expectedRevision && existsSync(file)) {
      const current = revision(await readFile(file, 'utf8'));
      if (current !== expectedRevision) throw new RevisionConflict(`Backlog has changed (revision ${current}, expected ${expectedRevision})`);
    }
    const text = toYaml(Backlog.parse(backlog));
    await writeFile(file, text);
    return revision(text);
  }

  async layout(id: string): Promise<Record<string, { x: number; y: number }>> {
    try {
      return JSON.parse(await readFile(this.path('entities', `${id}.layout.json`), 'utf8'));
    } catch {
      return {};
    }
  }

  async saveLayout(id: string, layout: Record<string, { x: number; y: number }>) {
    await writeFile(this.path('entities', `${id}.layout.json`), JSON.stringify(layout, null, 2) + '\n');
  }

  async proposals(): Promise<Proposal[]> {
    const files = await readdir(this.path('proposals')).catch(() => []);
    const list = await Promise.all(
      files.filter((f) => f.endsWith('.yaml')).map(async (f) => Proposal.parse(YAML.parse(await readFile(this.path('proposals', f), 'utf8')))),
    );
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async proposal(id: string): Promise<Proposal> {
    return Proposal.parse(YAML.parse(await readFile(this.path('proposals', `${id}.yaml`), 'utf8')));
  }

  async saveProposal(p: Proposal) {
    await mkdir(this.path('proposals'), { recursive: true });
    await writeFile(this.path('proposals', `${p.id}.yaml`), toYaml(Proposal.parse(p)));
  }

  async saveRun(report: RunReport) {
    await mkdir(this.path('runs'), { recursive: true });
    const text = JSON.stringify(RunReport.parse(report), null, 2) + '\n';
    await writeFile(this.path('runs', `${report.id}.json`), text);
  }

  // The latest known result of each scenario across all runs.
  async latestResults(): Promise<Record<string, ScenarioResult>> {
    const files = (await readdir(this.path('runs')).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
    const merged: Record<string, ScenarioResult> = {};
    for (const f of files) {
      const r = RunReport.safeParse(JSON.parse(await readFile(this.path('runs', f), 'utf8')));
      if (r.success) Object.assign(merged, r.data.results);
    }
    return merged;
  }
}

export class RevisionConflict extends Error {}

// Writes `next` over a YAML file, rewriting only what changed, through the
// `yaml` package's Document API — so comments and formatting everywhere else
// survive a save that, say, only adds a field to one role. A file that doesn't
// exist yet gets a fresh dump; there are no comments to lose. Returns the text.
async function writeChangedKeys<T extends object>(file: string, next: T, parse: (v: unknown) => T): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    const out = toYaml(next);
    await writeFile(file, out);
    return out;
  }
  const doc = YAML.parseDocument(text);
  if (YAML.isMap(doc.contents)) patchNode(doc, doc.contents, parse(doc.toJS() ?? {}), next);
  else doc.contents = doc.createNode(prune(next)) as typeof doc.contents;
  // The same style as toYaml, so untouched keys keep their text: no folding
  // of long lines, no padding inside flow lists ([a, b], not [ a, b ]).
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  await writeFile(file, out);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Brings a map or a list node in line with `next`. `current` is what the node
// holds now, parsed the same way as `next` (defaults filled in), so a value
// only differs when the save really changed it. A map descends key by key, a
// list of the same length item by item; anything else is replaced whole.
function patchNode(doc: YAML.Document, node: YAML.YAMLMap | YAML.YAMLSeq, current: unknown, next: unknown): void {
  const update = (key: string | number, cur: unknown, value: unknown, set: (v: unknown) => void, drop: () => void) => {
    if (same(cur, value)) return;
    // prune decides what a fresh dump would leave out (an empty `fields`, `secret: false`).
    const kept = typeof key === 'string' ? (prune({ [key]: value }) as Record<string, unknown>)[key] : prune(value);
    if (kept === undefined) return drop();
    const child = node.get(key, true);
    const nested = (isRecord(cur) && isRecord(value)) || (Array.isArray(cur) && Array.isArray(value) && cur.length === value.length);
    if (nested && (YAML.isMap(child) || YAML.isSeq(child))) patchNode(doc, child, cur, value);
    else set(doc.createNode(kept));
  };
  if (YAML.isMap(node) && isRecord(current) && isRecord(next)) {
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)]))
      update(key, current[key], next[key], (v) => node.set(key, v), () => node.delete(key));
  } else if (YAML.isSeq(node) && Array.isArray(current) && Array.isArray(next)) {
    next.forEach((item, i) => update(i, current[i], item, (v) => node.set(i, v), () => node.delete(i)));
  }
}

export function revision(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// A source id, kebab-cased from a file name: lowercase, non-Latin runs become
// a single "-", and a slug that would start with a digit gets an "s-" prefix
// so it still matches the model's id pattern.
function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
  return /^[a-z]/.test(slug) ? slug : `s-${slug}`;
}

// Empty optional fields are not written — the file stays readable and diffs stay clean.
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (k === 'secret' && x === false) continue;
      if (Array.isArray(x) && x.length === 0 && ['guards', 'effects', 'setup', 'evidence', 'refs', 'actions', 'permits', 'scenarios', 'tags', 'fields'].includes(k)) continue;
      out[k] = prune(x);
    }
    return out;
  }
  return v;
}

export function toYaml(v: unknown): string {
  return YAML.stringify(prune(v), { lineWidth: 0, aliasDuplicateObjects: false });
}
