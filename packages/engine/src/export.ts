import { mkdir, writeFile } from 'node:fs/promises';
import { buildPlan, renderMarkdown, type Workspace } from '@tc/model';

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
