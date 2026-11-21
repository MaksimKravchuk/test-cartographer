import { useEffect, useState } from 'react';
import type { Entity } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import type { Selection } from '../graph.ts';
import { Inspector } from './Inspector.tsx';

// How the tests reach the app for one object: how its state is read, how each state is
// set up, which tools perform its actions, its variants and relations. The engine needs
// it, a person reading the model doesn't, so it stays folded and an agent usually fills it.
// Edits collect in a draft until saved, since its fields change on every keystroke.
export function TechDetails({ state, project, onSave }: { state: EntityState; project: ProjectState; onSave(e: Entity, revision: string): Promise<unknown> }) {
  const [draft, setDraft] = useState<Entity>(state.entity);
  // The revision the draft started from: saving with it turns a change made meanwhile
  // (a state added on the page above) into a conflict instead of silently dropping it.
  const [base, setBase] = useState(state.revision);
  // Edits are measured against what the draft started from, not the latest entity, so a change
  // saved elsewhere on the page doesn't look like an unsaved edit here.
  const [start, setStart] = useState<Entity>(state.entity);
  const [selection, setSelection] = useState<Selection>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  const reset = () => { setDraft(state.entity); setStart(state.entity); setBase(state.revision); };
  // A save or a change on disk brings in the new version unless there are edits here.
  useEffect(() => { if (!dirty) reset(); }, [state.entity]);
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
            <button type="button" className="btn small" onClick={reset}>Discard</button>
            <button type="button" className="btn small primary" onClick={() => void onSave(draft, base)}>Save</button>
          </>
        )}
      </div>
      <Inspector entity={draft} state={state} project={project} selection={selection} onSelect={setSelection} onChange={setDraft} />
    </details>
  );
}
