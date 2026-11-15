import { mkdir, writeFile } from 'node:fs/promises';
import { buildPlan, disagreements, renderMarkdown, renderSpec, type Workspace } from '@tc/model';

export async function exportMarkdown(ws: Workspace): Promise<string[]> {
  const project = await ws.project();
  const catalog = await ws.catalog();
  const results = await ws.latestResults();
  await mkdir(ws.path('export'), { recursive: true });
  const files: string[] = [];
  for (const id of await ws.entityIds()) {
    const { entity } = await ws.entity(id);
    const file = `export/${id}.md`;
    await writeFile(ws.path(file), renderMarkdown(project, entity, buildPlan(entity, project, catalog), results));
    files.push(file);
  }
  return files;
}

// The product specification (see renderSpec) as workspace/export/spec.md.
export async function specMarkdown(ws: Workspace): Promise<string> {
  const { sources, usePriority } = await ws.sourceRegistry();
  const project = await ws.project();
  const catalog = await ws.catalog();
  const entities = Object.values(catalog);
  return renderSpec(project, entities, disagreements(await ws.proposals(), sources, usePriority), sources, entities.map((e) => buildPlan(e, project, catalog)));
}

export async function exportSpec(ws: Workspace): Promise<string> {
  await mkdir(ws.path('export'), { recursive: true });
  await writeFile(ws.path('export/spec.md'), await specMarkdown(ws));
  return 'export/spec.md';
}
