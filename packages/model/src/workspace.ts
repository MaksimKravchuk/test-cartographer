import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { Entity, Project, Proposal, RunReport, type ScenarioResult } from './schema.ts';

// A workspace is a plain folder that is easy to keep in git:
//   cartographer.yaml     project: interfaces, roles, MCP, inference, agents
//   entities/*.yaml       entity models
//   entities/*.layout.json  graph node positions (separate, to keep diffs quiet)
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
    const text = toYaml(Entity.parse(entity));
    await mkdir(this.path('entities'), { recursive: true });
    await writeFile(file, text);
    return revision(text);
  }

  // Removing an entity moves its files to entities/.trash, so nothing is lost by a misclick.
  async trashEntity(id: string): Promise<void> {
    const { rename } = await import('node:fs/promises');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(this.path('entities', '.trash'), { recursive: true });
    await rename(this.path('entities', `${id}.yaml`), this.path('entities', '.trash', `${id}-${stamp}.yaml`));
    if (existsSync(this.path('entities', `${id}.layout.json`)))
      await rename(this.path('entities', `${id}.layout.json`), this.path('entities', '.trash', `${id}-${stamp}.layout.json`));
  }

  async saveProject(project: Project): Promise<void> {
    await writeFile(this.path('cartographer.yaml'), toYaml(Project.parse(project)));
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

export function revision(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// Empty optional fields are not written — the file stays readable and diffs stay clean.
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (Array.isArray(x) && x.length === 0 && ['guards', 'effects', 'setup', 'evidence', 'refs', 'forbidden', 'scenarios', 'tags'].includes(k)) continue;
      out[k] = prune(x);
    }
    return out;
  }
  return v;
}

export function toYaml(v: unknown): string {
  return YAML.stringify(prune(v), { lineWidth: 0, aliasDuplicateObjects: false });
}
