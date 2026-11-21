import { useEffect, useState } from 'react';
import type { Entity } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import type { Selection } from '../graph.ts';
import { Inspector } from './Inspector.tsx';

// How the tests reach the app for one object: how its state is read, how each state is
// set up, which tools perform its actions, its variants and relations. The engine needs
// it, a person reading the model doesn't, so it stays folded and an agent usually fills it.
// Edits collect in a draft until saved, since its fields change on every keystroke.
export function TechDetails({ state, project, onSave }: { state: EntityState; project: ProjectState; onSave(e: Entity): Promise<unknown> }) {
  const [draft, setDraft] = useState<Entity>(state.entity);
  const [selection, setSelection] = useState<Selection>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.entity);
  // A save or a change on disk brings in the new version unless there are edits here.
  useEffect(() => {
    if (!dirty) setDraft(state.entity);
  }, [state.entity]);
  const problems = state.issues.length;
  return (
    <details className="tech" open={dirty || undefined}>
      <summary>
        How tests connect to the app
        {problems > 0 && <span className="tag contradicts">{problems} {problems === 1 ? 'problem' : 'problems'}</span>}
      </summary>
      <div className="tech-bar">
        {selection && <button type="button" className="btn small ghost" onClick={() => setSelection(null)}>← Everything</button>}
        <span className="spacer" />
        {dirty && (
          <>
            <span className="muted">Unsaved changes</span>
            <button type="button" className="btn small" onClick={() => setDraft(state.entity)}>Discard</button>
            <button type="button" className="btn small primary" onClick={() => void onSave(draft)}>Save</button>
          </>
        )}
      </div>
      <Inspector entity={draft} state={state} project={project} selection={selection} onSelect={setSelection} onChange={setDraft} />
    </details>
  );
}
