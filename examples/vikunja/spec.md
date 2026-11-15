# Vikunja case study — specification

## Subjects

- **Guest (signed out)** — a person
- **Project owner** — a person
- **User with Admin share** — a person
- **User with Read & Write share** — a person
- **User with Read only share** — a person
- **Signed-in user without a share** — a person
- **Vikunja scheduled trash cleanup** — background jobs and integrations

## Objects

- **Project** — The place where tasks live. Projects can be nested under one another, shared with users, teams or a link, archived, and moved to the trash.
- **Task** — A single to-do item inside a project. It can be marked done and reopened, moved to another project, duplicated and moved to the trash.

## Project

The place where tasks live. Projects can be nested under one another, shared with users, teams or a link, archived, and moved to the trash.

States: Active · Archived (read-only) · In the trash

### Project owner, Signed-in user without a share → Create a project

- Rule: A project in the trash keeps its identifier, and the same identifier cannot be given to another project until the trashed one is gone for good. — Vikunja help — Trash _(no test)_
- Rule: A sub-project can be created directly from the three-dot menu of another project, and doing so needs Read & Write or Admin permission on that parent project. — Vikunja help — Projects, Vikunja code — pkg/models (v2.8.0) _(no test)_

### Project owner, User with Admin share, User with Read & Write share, User with Read only share → Open a project

- No rules yet.

### Project owner, User with Admin share, User with Read & Write share → Change project settings (title, description, identifier, colour)

- Rule: Archiving a project hides it from the main working views and makes it read-only, so nothing in it can be changed until it is unarchived. — Vikunja help — Projects, Vikunja code — pkg/models (v2.8.0) _(no test)_
- Rule: The project identifier is a short code combined with task numbers to build task references like MOVE-42, and it is globally unique across all projects. — Vikunja help — Projects _(no test)_
- Rule: Someone shared at Read only can view everything in the project but cannot make any changes, and Read only is what a new share gets by default. — Vikunja help — Permissions _(no test)_

### Project owner, User with Admin share, User with Read & Write share → Archive the project

- Moves project from Active to Archived (read-only) — tests: `project/archive.owner/top_level`, `project/archive.admin/top_level`, `project/archive.writer/top_level`

### Project owner, User with Admin share, User with Read & Write share → Unarchive the project

- Moves project from Archived (read-only) to Active — tests: `project/unarchive.owner/top_level`, `project/unarchive.admin/top_level`, `project/unarchive.writer/top_level`

### Project owner, User with Admin share → Delete the project (move it to the trash)

- Moves project from Active to In the trash — tests: `project/trash.owner/top_level`, `project/trash.admin/top_level`
- Rule: You need Admin permission on the project to move it to the trash. — Vikunja help — Trash — tests: `project/deny-trash-guest-active/top_level`, `project/deny-trash-writer-active/top_level`, `project/deny-trash-reader-active/top_level`, `project/deny-trash-outsider-active/top_level`
- Rule: Deleting a project also moves all of its sub-projects, and their tasks, to the trash. — Vikunja help — Trash, Vikunja help — Projects _(no test)_
- Rule: You can delete your own default project, but not a project that another user owns and uses as their default project. If you delete your own default project you no longer have one, and restoring it does not make it the default again. — Vikunja help — Trash, Vikunja code — pkg/models (v2.8.0) _(no test)_
- Rule: Link shares of a deleted project stop working while it is in the trash and work again after the project is restored; deleting the project forever removes them. — Vikunja help — Trash _(no test)_

### Project owner, User with Admin share → Restore the project from the trash

- Moves project from In the trash to Active — tests: `project/restore.owner/top_level`, `project/restore.admin/top_level`
- Rule: A project in the trash is only visible to, and restorable by, someone with Admin permission on it. — Vikunja help — Trash, Vikunja code — pkg/models (v2.8.0) — tests: `project/deny-restore-guest-in_trash/top_level`, `project/deny-restore-writer-in_trash/top_level`, `project/deny-restore-reader-in_trash/top_level`, `project/deny-restore-outsider-in_trash/top_level`
- Rule: You can't restore a sub-project on its own while its parent project is in the trash. Restoring the topmost deleted parent brings everything under it back, including that sub-project. — Vikunja help — Trash _(no test)_
- Rule: The Restore parent project button is only shown to someone who has Admin permission on that parent project. — Vikunja help — Trash _(no test)_
- Rule: A project whose parent project is archived cannot be restored until the parent is unarchived. — Vikunja help — Trash _(no test)_

### Project owner, User with Admin share → Share the project with a user

- Rule: Only someone with Admin permission on the project can add or remove other users and teams and change their permission levels. — Vikunja help — Permissions, Vikunja code — pkg/models (v2.8.0) _(no test)_

### Nobody yet → See who the project is shared with

- No rules yet.

### Nobody yet → Add the project to your favorites

- No rules yet.

### Always true

- While a project is in the trash it can be restored by a project admin, it shows how many days are left before it is deleted permanently, and its identifier stays reserved. _(in In the trash)_ _(not checkable yet: no field values)_

### Open questions

- Gap: Sharing visibility is wider in the code than the model says: permit view_shares_read_write and rule shares_visible_to_read_and_write give the Share page's user/team list to a Read & Write share, but the code only requires read access to list a project's users, so a Read only share would see it too (link shares are excluded). No help page says who may see the list of users and teams (help-sharing only covers the Admin-only link-share list). Proposed as behaviour to verify, not as a requirement; searched help-sharing, help-permissions, help-projects.
- Gap: Code-only behaviour (not a requirement): a project cannot be nested in itself or in one of its own descendants, and it cannot be moved under an archived parent. Both are refusals a tester can see when editing the parent project; proposed as rules no_cyclic_nesting and cannot_move_under_archived_parent. Searched help-projects ('Sub-projects'), help-permissions, help-trash — none mentions either case.
- Gap: Favoriting a project is documented in help-projects (star icon in the sidebar or the overview, favorites pinned to the top) but the model has no favorite action for a project, even though the task entity has one. Proposed as action project.favorite. No source says which permission level it needs, and the code stores it per user, so no `by` is proposed. Searched help-projects, help-permissions.
- Gap: Permission levels for update/archive/unarchive and duplicate remain unstated in the requirements: help-permissions only says Read & Write may change 'the project's content' and help-projects only describes the menu entries. The code requires write access for edit/archive/unarchive and read+write-on-parent for duplicate, which is what the permits and rules already say. Searched help-projects ('Project settings', 'Archiving a project', 'Duplicating a project'), help-permissions, help-trash.
- Question: state:project.purged has no observable at all: no source says what a tester sees after a project is deleted forever beyond its disappearance, and the code simply removes the row. Should purged be matched by the reader failing to find the project, and if so where should that be written down? Searched help-trash ('Deleting permanently', 'Automatic deletion after 30 days'), help-projects.
- Question: state:project.in_trash is observable only through the trash listing and the notice on the project's page; the only field any source names is deleted_at (plus deleted_by on trashed projects). Should the match assert on deleted_at being set, once a reader is fixed?
- Question: On an archived project the menu offers only Un-Archive, but the Edit, Share and Duplicate pages are still reachable from the address bar. Edit then fails with 'The project is archived and can therefore only be accessed read only...' and nothing changes, Share shows read-only, but Duplicate succeeds. Is duplicating an archived project meant to be possible for a Read & Write share, given the menu hides it?
- Question: Neither duplicate could be verified with the model's reader: reading project 22 (copy of the active project) and project 23 (copy of the archived project) both answer 'You don't have the permission to see this', apparently because the copy belongs to the user who duplicated it and not to the account the reader uses. The copies' states are evidenced only from the web app: 22 appears in the project list as an ordinary project, 23 shows the archived notice and stays out of the list.
- Question: Besides the six actions in scope, the project menu of the shared active project also offers a Read & Write share: Views, Background settings, Webhooks, Subscribe and 'Create project' (a sub-project under the shared project). None of these are in the model and none were tried in this run.
- Question: No help page says which permission level is needed to archive, unarchive or edit a project's settings — help-permissions only lists what Read & Write may do to 'the project's content', and help-projects just describes the three-dot menu. The code requires write access (Read & Write, Admin or owner), which is what the transitions and the update permit propose. Searched help-projects ('Project settings', 'Archiving a project'), help-permissions, help-trash.
- Question: Nothing in the help pages states what permission is needed to duplicate a project; only the code says read access to the project plus write access to the parent of the copy. Should the rule be treated as a requirement? Searched help-projects ('Duplicating a project'), help-permissions.
- Question: The code refuses to archive a project that is someone's default (Inbox) project, but no help page mentions this — help-trash only covers deleting a default project. Is 'a default project cannot be archived' intended behaviour or an undocumented restriction? Searched help-projects ('The inbox project', 'Archiving a project') and help-trash ('Default projects').
- Question: The 'in the trash' state has no observable field proposed (match is empty) because no source says what the app shows for it beyond the trash listing and a notice; the code field is deleted_at, but there is no reader for this entity yet. Where should a tester observe that a project is in the trash?
- Question: Can a link share created with Admin permission move the project to the trash? help-permissions says every sharing method uses the same three levels and that admins may delete the project, while help-trash says link share users have no trash at all — so the project would go somewhere its deleter cannot see. Searched help-permissions, help-sharing ('What recipients see'), help-trash ('Who can do what').


## Task

A single to-do item inside a project. It can be marked done and reopened, moved to another project, duplicated and moved to the trash.

States: Open · Done · In the trash

### Project owner, User with Admin share, User with Read & Write share → Create a task

- Moves task from (new) to Open — tests: `task/create.owner/one_off`, `task/create.admin/one_off`, `task/create.writer/one_off`

### Project owner, User with Admin share, User with Read & Write share, User with Read only share → Open the task detail view

- Rule: On a task in a project shared Read only nothing can be acted on: the done checkbox in the list, table and kanban views is disabled, the task detail view shows no action buttons (no Mark task done, Assign, Labels, Move, Duplicate, Delete), the title and description cannot be edited, there is no comment box, and the keyboard shortcuts of the task page (mark done, delete, favourite) do nothing. The same user's own task shows the full set of those buttons. _(no test)_

### Project owner, User with Admin share, User with Read & Write share → Edit the task (title, description, dates, priority, progress, colour)

- Rule: Someone with Read & Write permission on the project can create, update and delete tasks in it. — Vikunja help — Permissions, Vikunja code — pkg/models (v2.8.0) _(no test)_
- Rule: Someone shared at Read only can view the project's tasks but cannot make any changes to them. — Vikunja help — Permissions _(no test)_
- Rule: A project that is archived shows the notice "This project is archived. It is not possible to create new or edit tasks for it." above its task list, and an attempt to change one of its tasks is answered with "The project is archived and can therefore only be accessed read only. This is also true for all tasks associated with this project." Its tasks stay readable. _(no test)_

### Project owner, User with Admin share, User with Read & Write share → Mark the task as done

- Moves task from Open to Done — tests: `task/mark_done.owner/one_off`, `task/mark_done.admin/one_off`, `task/mark_done.writer/one_off`
- Rule: An archived project is read-only, so its tasks cannot be changed until it is unarchived. — Vikunja help — Projects — tests: `task/rule-mark_done_needs_active_project-project-archived/one_off`, `task/rule-mark_done_needs_active_project-project-in_trash/one_off`
- Rule: Moving a task into the done bucket of a Kanban view marks the task as done, and moving it back out marks it as not done; the bucket picker in the task detail view has the same effect as dragging the task on the board. — Vikunja help — Tasks, Vikunja code — pkg/models (v2.8.0) _(no test)_

### Project owner, User with Admin share, User with Read & Write share → Reopen the task

- Moves task from Done to Open — tests: `task/reopen.owner/one_off`, `task/reopen.admin/one_off`, `task/reopen.writer/one_off`
- Rule: An archived project is read-only, so its tasks cannot be changed until it is unarchived. — Vikunja help — Projects — tests: `task/rule-reopen_needs_active_project-project-archived/one_off`, `task/rule-reopen_needs_active_project-project-in_trash/one_off`

### Project owner, User with Admin share, User with Read & Write share → Delete the task (move it to the trash)

- Moves task from Open to In the trash — tests: `task/trash_open.owner/one_off`, `task/trash_open.admin/one_off`, `task/trash_open.writer/one_off`
- Moves task from Done to In the trash — tests: `task/trash_done.owner/one_off`, `task/trash_done.admin/one_off`, `task/trash_done.writer/one_off`
- Rule: You need Read & Write permission on the project to delete a task. — Vikunja help — Trash — tests: `task/deny-trash-guest-open/one_off`, `task/deny-trash-reader-open/one_off`, `task/deny-trash-outsider-open/one_off`
- Rule: A deleted task moves to the trash right away, without a confirmation dialog, and the message that appears has an Undo button that brings it straight back. — Vikunja help — Tasks _(no test)_
- Rule: An archived project is read-only, so its tasks cannot be changed until it is unarchived. — Vikunja help — Projects — tests: `task/rule-trash_open_needs_active_project-project-archived/one_off`, `task/rule-trash_open_needs_active_project-project-in_trash/one_off`

### Project owner, User with Admin share, User with Read & Write share → Restore the task from the trash

- Moves task from In the trash to Open — tests: `task/restore.owner/one_off`, `task/restore.admin/one_off`, `task/restore.writer/one_off`
- Rule: Read & Write permission on the project is enough to see a task in the trash and restore it; without it the task is not listed. — Vikunja help — Trash, Vikunja code — pkg/models (v2.8.0) — tests: `task/deny-restore-guest-in_trash/one_off`, `task/deny-restore-reader-in_trash/one_off`, `task/deny-restore-outsider-in_trash/one_off`
- Rule: You can't restore a task while its project is archived, and such tasks are not listed in the trash; the project has to be unarchived first. — Vikunja help — Trash _(no test)_
- Rule: While a project is in the trash its tasks are not listed in the task trash, even tasks that were deleted on their own; the project has to be restored first. — Vikunja help — Trash _(no test)_

### Nobody yet → Add the task to your favorites

- No rules yet.

### Open questions

- Gap: Requirement missing from the model: help-tasks says moving a task into the done bucket marks it done and moving it out marks it not done (the detail view's bucket picker behaves the same), and the code sets done when a task is placed in the done bucket. Proposed as rule done_bucket_marks_done on mark_done; it is a second, view-driven way to reach the done state that no transition currently mentions.
- Gap: Requirement missing from the model: help-trash describes Empty trash as tab-local, limited to items you may delete permanently, with a checked option to also delete items other people moved to the trash; the code implements exactly that (EmptyTaskTrash over projects the user administers, 'without includeOthers, tasks someone else deleted stay'). Proposed as rule empty_trash_scope on task.delete_permanently; the same dialog exists for the Projects tab, so the project entity needs the mirror rule if this one is accepted.
- Gap: Code-only behaviour (not a requirement): when a repeating task is marked done and reopens for its next occurrence, the checklist items in its description are unchecked again. Visible to a tester with a checklist in the description. Searched help-tasks ('Checklists', 'Marking a task as done'), help-projects, help-trash — no page mentions it.
- Gap: Still unmodeled parts of help-tasks: comments (with @mentions and ordering), labels, priority, progress, colour, dates and reminders, attachments and previews, relations, subscribing/unsubscribing, checklists, Quick Add Magic, the hover preview and the bookmarklet. They remain folded into the broad update action, and subscriptions in particular are a separate user-visible command with its own rules ('you are subscribed automatically when you create a task or are assigned to one'). Searched help-tasks in full.
- Question: state:task.purged has no observable: no source says what a tester sees after a task is deleted forever, and no source describes the keyboard-shortcut path either (the earlier open question about shortcuts answering nothing for a Read only share stays open — searched help-tasks and help-trash, which document `Delete`/`Backspace` on the task page but no response).
- Question: A Read only share cannot see the project's deleted task in the trash (the trash says "There are no tasks in the trash." and Empty trash is disabled), yet opening that same deleted task by its own link still shows a page telling who deleted it, how long ago, and that it will be deleted permanently in 30 days. Is this leak of the deletion notice to a Read only share intended? I proposed a separate permit for it rather than widening the existing view_trash permit, because the task genuinely is not listed in the trash.
- Question: The model relates a Task to a project that "requires: active", but a Read only share can read tasks of an archived project without any limitation (task list and detail view of project 43 and tasks 19/20). Should the Task model describe the archived-project case as a variant/condition rather than assume an active project?
- Question: The Task Page keyboard shortcuts documented in the app's own Keyboard Shortcuts dialog (t mark done / undone, Delete delete this task, s favourite, m move, a assign, e edit description) produce no reaction at all for a Read only share — no change and no error message — so no server answer could be recorded for those verbs; read() of task 16 afterwards still shows it open. It cannot be told from the interface whether the request was never sent or silently refused.
- Question: The server answer to a Read only share confirming "Delete this project" could not be captured: after Do it! the dialog stayed open and the project remained listed, but the toast had already disappeared by the time of the next snapshot. Edit and Archive under the same conditions both answered "Forbidden".
- Question: No source says which permission level is needed to mark a task done or edit it: help-tasks only describes the Done button and the detail view, and help-permissions only says Read & Write may 'create, update, and delete tasks'. The code treats every task change as needing write access on the project, which is what the transitions propose. Searched help-tasks, help-permissions, help-trash.
- Question: Does a task that was done keep its done state after being restored from the trash? The only hint in the sources is the trash page's Kanban note that a restored task goes into the done bucket if the task is done; no page states it directly. The restore_done transition is proposed on that basis and needs confirmation.
- Question: The 'in the trash' state has no observable field (match is empty): the sources only describe the trash screen and a notice reading 'This task is in the trash.', and no reader is defined for the task entity. Where should a tester observe that a task is in the trash?
- Gap: Repeating tasks are only described in the code (the repeat interval and repeat mode) and in help-tasks' link to a Dates & Reminders page that is not among the sources, so the repeating variant and its reopen transition rest on code alone. Searched help-tasks, help-projects, help-trash for 'repeat'.
- Gap: help-tasks also documents comments, labels, priority, progress, colour, dates, attachments, relations, favourites, subscriptions, Quick Add Magic and the bookmarklet. Labels, attachments and views are out of this run's scope, and the rest are folded into one broad 'edit the task' action instead of separate actions — they are not modeled individually yet.

### Known defects

- The web app offers a task verb to a Read only share that the server then refuses: every task row has an "Add to Favorites" button. In the active shared project the server answers "Forbidden" (shown twice), in the archived shared project it answers "The project is archived and can therefore only be accessed read only...". The model has no favourite action at all, so this verb (and its refusal for a Read only share) is not described anywhere; I proposed the action and a rule, a person should decide whether offering the button is intended. (Add to Favorites is offered to a Read only share and refused with Forbidden.)
- Project actions a Read only share must not have are hidden from the menus but still reachable by their direct links, with the forms fully enabled: /projects/<id>/settings/edit opens the Edit This Project dialog with an editable title and Save (Save answers "Forbidden", the title stays), /projects/<id>/settings/archive opens the archive confirmation (Do it! answers "Forbidden", the project stays active), /projects/<id>/settings/delete opens the delete confirmation (after Do it! the dialog stays open and the project remains in the sidebar). This is about the related Project entity, so I did not propose model operations for it. (Edit/Archive/Delete dialogs open by URL for a Read only share; the server refuses with 403, so only a UI defect.)

## Not checked by any test

- Project: rule “A project in the trash keeps its identifier, and the same identifier cannot be given to another project until the trashed one is gone for good.”
- Project: rule “A sub-project can be created directly from the three-dot menu of another project, and doing so needs Read & Write or Admin permission on that parent project.”
- Project: rule “Archiving a project hides it from the main working views and makes it read-only, so nothing in it can be changed until it is unarchived.”
- Project: rule “The project identifier is a short code combined with task numbers to build task references like MOVE-42, and it is globally unique across all projects.”
- Project: rule “Someone shared at Read only can view everything in the project but cannot make any changes, and Read only is what a new share gets by default.”
- Project: rule “Deleting a project also moves all of its sub-projects, and their tasks, to the trash.”
- Project: rule “You can delete your own default project, but not a project that another user owns and uses as their default project. If you delete your own default project you no longer have one, and restoring it does not make it the default again.”
- Project: rule “Link shares of a deleted project stop working while it is in the trash and work again after the project is restored; deleting the project forever removes them.”
- Project: rule “You can't restore a sub-project on its own while its parent project is in the trash. Restoring the topmost deleted parent brings everything under it back, including that sub-project.”
- Project: rule “The Restore parent project button is only shown to someone who has Admin permission on that parent project.”
- Project: rule “A project whose parent project is archived cannot be restored until the parent is unarchived.”
- Project: rule “Only someone with Admin permission on the project can add or remove other users and teams and change their permission levels.”
- Task: rule “On a task in a project shared Read only nothing can be acted on: the done checkbox in the list, table and kanban views is disabled, the task detail view shows no action buttons (no Mark task done, Assign, Labels, Move, Duplicate, Delete), the title and description cannot be edited, there is no comment box, and the keyboard shortcuts of the task page (mark done, delete, favourite) do nothing. The same user's own task shows the full set of those buttons.”
- Task: rule “Someone with Read & Write permission on the project can create, update and delete tasks in it.”
- Task: rule “Someone shared at Read only can view the project's tasks but cannot make any changes to them.”
- Task: rule “A project that is archived shows the notice "This project is archived. It is not possible to create new or edit tasks for it." above its task list, and an attempt to change one of its tasks is answered with "The project is archived and can therefore only be accessed read only. This is also true for all tasks associated with this project." Its tasks stay readable.”
- Task: rule “Moving a task into the done bucket of a Kanban view marks the task as done, and moving it back out marks it as not done; the bucket picker in the task detail view has the same effect as dragging the task on the board.”
- Task: rule “A deleted task moves to the trash right away, without a confirmation dialog, and the message that appears has an Undo button that brings it straight back.”
- Task: rule “You can't restore a task while its project is archived, and such tasks are not listed in the trash; the project has to be unarchived first.”
- Task: rule “While a project is in the trash its tasks are not listed in the task trash, even tasks that were deleted on their own; the project has to be restored first.”
