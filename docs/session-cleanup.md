# Native session cleanup API

Pi Pocket 0.28.0 derived build. This build adds real session-tree deletion. It is not available in stock upstream and is not the same as **Archive**, which keeps history.

## Behavior

- A top-level root and its **true native subagent descendants** are selected using conversation ownership, at any depth.
- Linked sessions, fork ancestry and sessions sharing only a model/CWD/title are not selected automatically.
- Selected scheduling, goals, hooks, watches, shell/browser/background work, room state, limits, alerts and attribution are stopped and cleaned.
- Conversation/task rows, task and conversation documents, obsolete revisions, submissions and unreferenced entries are erased in the same durable commit as session metadata and the receipt.
- Entry prefixes required by surviving forks remain available to those forks. Hidden ancestry remains until its last dependent fork is deleted. Session APIs do not return hidden ancestors.
- Project directories, worktrees, branches, uploads and shared assets are never deleted: Pocket does not record exclusive file ownership. The result warns about preservation.
- Record IDs remain reserved. SQLite schema 3 prevents older runtimes from mistaking hidden ancestry for live sessions.

## Owner HTTP API

All requests require owner authentication, and mutations require `X-Pocket: 1`.

```http
POST /api/session-cleanup/preview
{ "ids": [3, 9] }

POST /api/session-cleanup
{ "ids": [3, 9], "revision": "<preview revision>", "requestId": "<stable id>" }
```

The preview remains available for inspection but is not additional consent authority: native owner rights and Plan/approval policy already govern. The revision identifies the selected ownership closure. A new subagent between preview and deletion returns **409** before stopping work. Repeating a completed request key returns `already_deleted` without repeating effects; an operation already running returns **409**, not a queue entry. Unsupported storage returns **501**.

`ids` accepts 1–50 distinct positive safe-integer roots. PiP, protected SDK roots, guests/viewers, missing IDs and non-root conversations are rejected.

Public extension request methods:

```ts
planSessionDeletion(ids: readonly number[]): Promise<SessionDeletionPreview>
deleteSessions(request: { ids: readonly number[]; revision?: string; requestId: string }): Promise<SessionDeletionOutcome>
```

Server events emit `session.deleted` only after the purge committed.

## Limits

- No external-effect rollback: delivered notifications/remote side effects cannot be recalled. Extension command handlers and native work receive cooperative cancellation.
- A disconnected client does not mean rollback; retry the identical `requestId` to reconcile.
- Counts can differ from preview because stopping live work may append final records.
- Deletion requires a writable harness with SQLite or Memory storage. Other backends fail explicitly.
- This build has no audit UI for hidden ancestry; it is internal retention for surviving forks.

## Related

- [Session Cleanup extension](https://github.com/MasFana/pi-session-cleanup) — owner UI and installation instructions.
- [Runtime source](https://github.com/MasFana/pi-session-cleanup-runtime/tree/0152bfe01b27239855bff247611b93a19cf3edce/packages/durable) — the maintained 1.6.0 cleanup fork implementing purge and schema 3.