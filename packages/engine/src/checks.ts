import { validateEntity, validateProject, type Issue, type Workspace } from '@tc/model';
import { loadActions } from './actions-loader.ts';

// Full workspace check: the project, all entities and whether actions exist in the library.
export async function validateAll(ws: Workspace): Promise<Issue[]> {
  const project = await ws.project();
  const catalog = await ws.catalog();
  const actions = await loadActions(ws).catch(() => undefined);
  const issues = validateProject(project, actions && new Set(Object.keys(actions)));
  for (const id of await ws.entityIds()) {
    const { entity } = await ws.entity(id);
    issues.push(...validateEntity(entity, project, actions && new Set(Object.keys(actions)), catalog).map((i) => ({ ...i, path: `${id}.${i.path}` })));
  }
  return issues;
}
