import { NEW, type Entity, type Project } from './schema.ts';
import { arrange, isActive, type Catalog } from './reach.ts';

export type Issue = { level: 'error' | 'warning'; path: string; message: string };

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

function toolAllowed(project: Project, tool: string, kind: 'prepare' | 'read'): boolean {
  const [server, name] = tool.split('.');
  return !!project.mcp[server]?.allow[kind].includes(name);
}

export function validateProject(project: Project, actions?: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const ifaces = new Set(project.interfaces.map((i) => i.id));
  for (const d of duplicates(project.interfaces.map((i) => i.id)))
    issues.push({ level: 'error', path: `interfaces.${d}`, message: 'Duplicate interface id' });
  for (const d of duplicates(project.roles.map((r) => r.id)))
    issues.push({ level: 'error', path: `roles.${d}`, message: 'Duplicate role id' });
  for (const r of project.roles)
    if (!ifaces.has(r.interface))
      issues.push({ level: 'error', path: `roles.${r.id}`, message: `Unknown interface “${r.interface}”` });
  for (const r of project.roles)
    if (r.login && actions && !actions.has(r.login.action))
      issues.push({ level: 'warning', path: `roles.${r.id}`, message: `Login action “${r.login.action}” is not implemented in the actions/ library` });
  return issues;
}

// Checks the entity's referential integrity and its consistency with the project.
// `actions` — known action names from the library (checked if provided).
export function validateEntity(entity: Entity, project: Project, actions?: Set<string>, catalog?: Catalog): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  const variants = new Set(entity.variants.map((v) => v.id));
  const states = new Map(entity.states.map((s) => [s.id, s]));
  const transitions = new Map(entity.transitions.map((t) => [t.id, t]));
  const roles = new Set(project.roles.map((r) => r.id));

  for (const [kind, list] of [
    ['variants', entity.variants],
    ['states', entity.states],
    ['transitions', entity.transitions],
    ['forbidden', entity.forbidden],
    ['scenarios', entity.scenarios],
    ['rules', entity.rules],
    ['relations', entity.relations],
  ] as const)
    for (const d of duplicates(list.map((x) => x.id))) err(`${kind}.${d}`, 'Duplicate id');

  if (!toolAllowed(project, entity.reader.tool, 'read'))
    err('reader', `Read tool “${entity.reader.tool}” is not allowed in cartographer.yaml (mcp.*.allow.read)`);

  const checkVariants = (path: string, vs?: string[]) => {
    for (const v of vs ?? []) if (!variants.has(v)) err(path, `Unknown variant “${v}”`);
  };

  for (const s of entity.states) {
    const p = `states.${s.id}`;
    checkVariants(p, s.variants);
    if (Object.keys(s.match).length === 0) err(p, "Empty probe: the state can't be verified by reading");
    for (const setup of s.setup) {
      if (setup.kind === 'tool') {
        if (!toolAllowed(project, setup.tool, 'prepare'))
          err(`${p}.setup`, `Setup tool “${setup.tool}” is not allowed (mcp.*.allow.prepare)`);
      } else {
        if (!states.has(setup.from)) err(`${p}.setup`, `Unknown state “${setup.from}”`);
        for (const id of setup.via) if (!transitions.has(id)) err(`${p}.setup`, `Unknown transition “${id}”`);
      }
    }
  }

  for (const t of entity.transitions) {
    const p = `transitions.${t.id}`;
    checkVariants(p, t.variants);
    const from = states.get(t.from);
    const to = states.get(t.to);
    if (!from && t.from !== NEW) err(p, `Unknown state “${t.from}”`);
    if (!to) err(p, `Unknown state “${t.to}”`);
    if (!roles.has(t.role)) err(p, `Unknown role “${t.role}”`);
    if (actions && !actions.has(t.action)) warn(p, `Action “${t.action}” is not implemented in the actions/ library`);
    if (isActive(t) && ((from && !isActive(from)) || (to && !isActive(to))))
      warn(p, "A confirmed transition references a state that isn't a requirement — it won't be planned");
  }

  for (const f of entity.forbidden) {
    const p = `forbidden.${f.id}`;
    checkVariants(p, f.variants);
    if (!states.has(f.state) && f.state !== NEW) err(p, `Unknown state “${f.state}”`);
    if (!transitions.has(f.transition)) err(p, `Unknown transition “${f.transition}”`);
    if (!roles.has(f.role)) err(p, `Unknown role “${f.role}”`);
  }

  for (const j of entity.scenarios) {
    const p = `scenarios.${j.id}`;
    checkVariants(p, j.variants);
    if (!states.has(j.start) && j.start !== NEW) err(p, `Unknown state “${j.start}”`);
    let cur = j.start;
    for (const [i, id] of j.path.entries()) {
      const t = transitions.get(id);
      if (!t) {
        err(p, `Step ${i + 1}: unknown transition “${id}”`);
        break;
      }
      if (t.from !== cur) {
        err(p, `Step ${i + 1}: “${t.title}” starts in “${t.from}”, but the path is in “${cur}”`);
        break;
      }
      cur = t.to;
    }
  }

  for (const r of entity.rules) {
    const p = `rules.${r.id}`;
    checkVariants(p, r.variants);
    if (!transitions.has(r.transition)) err(p, `Unknown transition “${r.transition}”`);
    for (const c of r.requires) {
      if (c.kind === 'roles') for (const id of c.roles) if (!roles.has(id)) err(p, `Unknown role “${id}”`);
      if (c.kind === 'authenticated' && !project.roles.some((x) => !x.login))
        warn(p, 'No role without login (a guest), so the negative case of this rule can’t be checked');
      if (c.kind === 'entity-state') {
        const rel = entity.relations.find((x) => x.id === c.relation);
        if (!rel) err(p, `Unknown relation “${c.relation}”`);
        const target = rel && catalog?.[rel.entity];
        if (target) for (const id of c.states) if (!target.states.some((x) => x.id === id)) err(p, `${target.title} has no state “${id}”`);
      }
    }
  }

  for (const r of entity.relations) {
    const p = `relations.${r.id}`;
    if (!catalog) continue;
    const target = catalog[r.entity];
    if (!target) {
      err(p, `Unknown entity “${r.entity}”`);
      continue;
    }
    if (r.requires && !target.states.some((x) => x.id === r.requires)) err(p, `${target.title} has no state “${r.requires}”`);
    for (const [mine, theirs] of Object.entries(r.variants ?? {})) {
      if (!variants.has(mine)) err(p, `Unknown variant “${mine}”`);
      if (!target.variants.some((x) => x.id === theirs)) err(p, `${target.title} has no variant “${theirs}”`);
    }
  }
  const relationIds = new Set(entity.relations.map((r) => r.id));
  for (const t of entity.transitions)
    for (const e of t.effects) if (e.relation && !relationIds.has(e.relation)) err(`transitions.${t.id}`, `Unknown relation “${e.relation}”`);

  if (issues.some((i) => i.level === 'error')) return issues;

  for (const v of entity.variants.filter(isActive))
    for (const s of entity.states.filter(isActive))
      if ((!s.variants || s.variants.includes(v.id)) && !arrange(entity, v.id, s.id, new Set(), { catalog }))
        warn(`states.${s.id}`, `State unreachable for variant “${v.id}”: no setup recipe, no path, or a related instance that can't be prepared`);

  return issues;
}
