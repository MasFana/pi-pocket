// Real disposable Pocket/SQLite fixtures. No production data, credentials, or private runtime patches.
import {
    type App, cleanUp, context, modelTexts, newSession, openApp, owner,
    root, say, scriptedModel, until, work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND_MARKER } from "../src/server/background.ts";
import {
    ArtifactSharesDoc, BackgroundDoc, HooksDoc, NotesDoc, PublicLinksDoc,
    RepoWatchesDoc, SessionsDoc, SpendDoc,
} from "../src/server/docs.ts";
import { SessionCleanupReceiptsDoc } from "../src/server/session-cleanup.ts";

const model = scriptedModel();
const dataDir = join(root, "session-cleanup-data");
let app: App;
const backgrounds = new Set<ConversationId>();
const TaskProof = defineDoc({
    kind: "test.session-cleanup.task-proof", version: 1, scope: "task",
    checkpointWhen: () => false, initial: () => ({ text: "native owned task data" }),
});

before(async () => {
    app = await openApp(model, dataDir);
    app.background.timing = { look: 50, grace: 200, starting: 300, sweep: 60_000 };
});
after(async () => {
    for (const id of backgrounds) {
        for (const item of await app.background.list(id).catch(() => [])) {
            await app.background.stop(id, item.id).catch(() => undefined);
        }
    }
    await app?.close();
    cleanUp();
});

/** True native task ownership, not app-loaded descendants, fork ancestry, or linked metadata. */
async function ownedChild(parent: ConversationId): Promise<{ id: ConversationId; task: TaskId }> {
    const by = owner(app);
    return app.harness.commit(async (tx) => {
        const task = await tx.createTask(app.shell.task, {
            command: "sleep 300", by: by.id, name: by.name, context: false,
        }, { ownership: { kind: "conversation" }, conversationId: parent, background: true });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
        (await tx.doc(TaskProof, task)).text = `owned by ${Number(parent)}`;
        return { id: child.id, task };
    }, context);
}

function rows(sql: string, ...params: (number | string)[]) {
    const db = new DatabaseSync(join(dataDir, "pocket.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

function liveMarkedProcesses(id: ConversationId): number[] {
    const prefix = `${BACKGROUND_MARKER}=${dataDir}#${Number(id)}/`;
    return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((name) => {
        try {
            return !/\) [ZX] /.test(readFileSync(`/proc/${name}/stat`, "utf8")) &&
                readFileSync(`/proc/${name}/environ`, "utf8").split("\0").some((item) => item.startsWith(prefix));
        } catch { return false; }
    }).map(Number);
}

async function notes(id: ConversationId, text: string) {
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(NotesDoc, id);
        doc.text = text;
        doc.rev += 1;
    }, context);
}

async function metadata(id: ConversationId, kept: ConversationId, task: TaskId) {
    const actor = owner(app).id;
    const survivorTask = await app.shell.start(kept, owner(app), { command: "true", context: false, requestId: "survivor-owned-task" });
    await app.harness.commit(async (tx) => {
        const hooks = await tx.doc(HooksDoc);
        const watches = await tx.doc(RepoWatchesDoc);
        const shares = await tx.doc(ArtifactSharesDoc);
        const links = await tx.doc(PublicLinksDoc);
        const spend = await tx.doc(SpendDoc);
        for (const [key, target] of [["selected", id], ["survivor", kept]] as const) {
            hooks.items[key] = { id: key, secret: "disposable-test-only", name: key, instructions: "", target: Number(target), by: actor, createdAt: 1, count: 0 };
            // This metadata uses an actual owned task, not a polling task; no GitHub credentials or requests are used.
            watches.items[key] = { id: key, repo: "fixture/disposable", events: ["issues"], instructions: "", branch: "main", target: Number(target), by: actor, byPi: false, createdAt: 1, since: new Date(0).toISOString(), taskId: target === id ? task : survivorTask.taskId as TaskId, next: 1, seen: [], count: 0, errors: 0 };
            shares.items[key] = { conversation: String(target), id: "fixture", by: actor, createdAt: 1 };
            links.items[key] = { module: "fixture", createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, conversation: Number(target) };
            spend.counted[String(target)] = 0;
        }
        spend.people[actor] = 7;
    }, context);
}

test("purges the native child and grandchild, tasks, all document revisions and atomic metadata; cold reopen agrees", async () => {
    const id = await newSession(app);
    const kept = await newSession(app);
    const child = await ownedChild(id);
    const grandchild = await ownedChild(child.id);
    await notes(id, "first root revision");
    await notes(id, "second root revision");
    await notes(child.id, "child data");
    await notes(grandchild.id, "grandchild data");
    await say(app, id, "selected transcript");
    await say(app, kept, "survivor transcript");
    await metadata(id, kept, child.task);
    if (!app.schedules.running) await app.setExtensionEnabled(owner(app), "schedules.ts", true);
    const schedule = await app.schedules.add(id, { when: "in 1h", text: "must never fire after cleanup" });
    const ids = [Number(id), Number(child.id), Number(grandchild.id)];
    const placeholders = ids.map(() => "?").join(",");
    const documents = rows(`SELECT id FROM documents WHERE (scope_kind = 'conversation' AND owner_id IN (${placeholders})) OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id IN (${placeholders})))`, ...ids, ...ids).map((row) => Number(row.id));
    const tasks = rows(`SELECT id FROM tasks WHERE conversation_id IN (${placeholders})`, ...ids).map((row) => Number(row.id));
    assert.ok(documents.length > 0);
    assert.ok(tasks.includes(Number(child.task)) && tasks.includes(Number(grandchild.task)));
    const preview = await app.sessionCleanup.plan(owner(app), [Number(id)], context);
    assert.deepEqual(preview.ids, [Number(id)]);
    assert.equal(preview.conversations, 3);
    assert.equal(preview.subagents, 2);
    assert.ok(preview.documents >= documents.length);
    const request = { ids: [Number(id)], revision: preview.revision, requestId: "native-tree" };
    const deleted = await app.sessionCleanup.delete(owner(app), request, context);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.conversations, 3);
    assert.equal(deleted.subagents, 2);
    assert.equal(await app.harness.getTask(schedule.taskId, context), undefined, "sleeping native schedule was aborted and purged");
    for (const gone of [id, child.id, grandchild.id]) {
        assert.equal(await app.harness.conversation(gone, context), undefined);
        assert.equal(await app.harness.snapshot(NotesDoc, gone, context), undefined);
    }
    assert.equal(rows(`SELECT id FROM tasks WHERE conversation_id IN (${placeholders})`, ...ids).length, 0);
    assert.equal(rows(`SELECT id FROM submissions WHERE conversation_id IN (${placeholders})`, ...ids).length, 0);
    assert.equal(rows(`SELECT id FROM entries WHERE conversation_id IN (${placeholders})`, ...ids).length, 0);
    for (const doc of documents) {
        assert.equal(rows("SELECT id FROM documents WHERE id = ?", doc).length, 0);
        assert.equal(rows("SELECT seq FROM document_revisions WHERE document_id = ?", doc).length, 0);
        assert.equal(rows("SELECT id FROM record_ids WHERE id = ?", doc).length, 1, "ID stays reserved");
    }
    const sessions = (await app.harness.snapshot(SessionsDoc, context))!.items;
    assert.equal(sessions[String(id)], undefined);
    assert.ok(sessions[String(kept)]);
    const metadataValues = await Promise.all([
        app.harness.snapshot(HooksDoc, context),
        app.harness.snapshot(RepoWatchesDoc, context),
        app.harness.snapshot(ArtifactSharesDoc, context),
        app.harness.snapshot(PublicLinksDoc, context),
    ]);
    for (const value of metadataValues) {
        assert.equal(value?.items.selected, undefined);
        assert.ok(value?.items.survivor);
    }
    const spend = await app.harness.snapshot(SpendDoc, context);
    assert.equal(spend?.counted[String(id)], undefined);
    assert.equal(spend?.counted[String(kept)], 0);
    assert.equal(spend?.people[owner(app).id], 7, "aggregate accounting is preserved");
    const receipt = (await app.harness.snapshot(SessionCleanupReceiptsDoc, context))!.items.find((item) => item.requestId === request.requestId)!;
    assert.deepEqual(receipt.outcome, deleted);
    assert.deepEqual(Object.keys(receipt).sort(), ["actor", "at", "outcome", "requestId"]);
    assert.ok(!JSON.stringify(receipt).includes(work), "receipt contains no project paths");
    const storedReceipt = rows("SELECT created_at FROM documents WHERE kind = ?", JSON.stringify(SessionCleanupReceiptsDoc.definition.kind))[0];
    assert.ok(storedReceipt, "Native deletion receipt must be durable, not only cached");
    const purgeSeq = Number(storedReceipt.created_at);
    for (const kind of ["pocket.sessions", "pocket.hooks", "pocket.repo-watches", "pocket.artifact-shares", "pocket.public-links", "pocket.spend"]) {
        const latest = rows("SELECT MAX(r.seq) AS seq FROM document_revisions r JOIN documents d ON r.document_id = d.id WHERE d.kind = ?", JSON.stringify(kind))[0]!;
        assert.equal(Number(latest.seq), purgeSeq, `${kind} removal and the native receipt share the purge commit`);
    }
    const retry = await app.sessionCleanup.delete(owner(app), request, context);
    assert.deepEqual(retry, { ...deleted, status: "already_deleted" });
    await app.close();
    app = await openApp(model, dataDir);
    for (const gone of [id, child.id, grandchild.id]) assert.equal(await app.harness.conversation(gone, context), undefined);
    assert.match((await modelTexts(app, kept)).join("\n"), /survivor transcript/);
    assert.deepEqual(await app.sessionCleanup.delete(owner(app), request, context), retry);
    const fresh = await newSession(app);
    assert.ok(!ids.includes(Number(fresh)), "deleted stable IDs are not reused");
});

test("ordinary linked/forked sessions survive and only a fork's referenced entry prefix is retained", async () => {
    const id = await newSession(app);
    await say(app, id, "shared prefix");
    const entries = (await (await app.conversation(id)).entries({}, 100, undefined, context)).items;
    const answer = entries.find((entry) => entry.kind === "pi.assistant")!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(answer.id) });
    await say(app, id, "later private history");
    const linked = await newSession(app);
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(linked)]!.linkedFrom = { id: Number(id) };
    }, context);
    const preview = await app.sessionCleanup.plan(owner(app), [Number(id)], context);
    assert.equal(preview.conversations, 1);
    assert.ok(preview.retainedSharedEntries > 0);
    const result = await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], revision: preview.revision, requestId: "fork-prefix" }, context);
    assert.ok(result.retainedSharedEntries > 0);
    assert.equal(await app.harness.conversation(id, context), undefined);
    assert.ok(await app.harness.conversation(linked, context));
    const forkText = (await modelTexts(app, fork)).join("\n");
    assert.match(forkText, /shared prefix/);
    assert.doesNotMatch(forkText, /later private history/);
    assert.equal(rows("SELECT id FROM entries WHERE conversation_id = ? AND id > ?", Number(id), Number(answer.id)).length, 0);
    assert.equal(rows("SELECT id FROM conversations WHERE id = ? AND deleted_ancestry = 1", Number(id)).length, 1);
    await app.close();
    app = await openApp(model, dataDir);
    assert.match((await modelTexts(app, fork)).join("\n"), /shared prefix/);
    await app.sessionCleanup.delete(owner(app), { ids: [Number(fork)], requestId: "last-fork" }, context);
    assert.equal(rows("SELECT id FROM conversations WHERE id = ?", Number(id)).length, 0, "obsolete hidden ancestry collected");
    assert.equal(rows("SELECT id FROM entries WHERE conversation_id = ?", Number(id)).length, 0);
});

test("fresh owner authority, true roots, missing IDs, PiP and root zero are enforced before effects", async () => {
    const id = await newSession(app);
    const child = await ownedChild(id);
    const guest = app.config.addUser("Cleanup guest", "guest").user;
    const viewer = app.config.addUser("Cleanup viewer", "viewer").user;
    for (const actor of [guest, viewer, { ...guest, role: "owner" as const }, { ...owner(app), tokenHash: "stale-login" }]) {
        await assert.rejects(app.sessionCleanup.plan(actor, [Number(id)], context), { status: 403 });
        await assert.rejects(app.sessionCleanup.delete(actor, { ids: [Number(id)], requestId: "denied" }, context), { status: 403 });
    }
    await assert.rejects(app.sessionCleanup.plan(owner(app), [Number(child.id)], context), { status: 404 });
    await assert.rejects(app.sessionCleanup.plan(owner(app), [0], context), { status: 400 });
    await assert.rejects(app.sessionCleanup.plan(owner(app), [Number(ROOT_CONVERSATION_ID)], context), { status: 403 });
    await assert.rejects(app.sessionCleanup.delete(owner(app), { ids: [Number(ROOT_CONVERSATION_ID)], requestId: "reserved-root" }, context), { status: 403 });
    await assert.rejects(app.sessionCleanup.plan(owner(app), [Number.MAX_SAFE_INTEGER], context), { status: 404 });
    await assert.rejects(app.sessionCleanup.plan(owner(app), Array.from({ length: 51 }, () => Number(id)), context), { status: 400 });
    await app.harness.commit(async (tx) => { (await tx.doc(SessionsDoc)).items[String(id)]!.pip = owner(app).id; }, context);
    await assert.rejects(app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "protected" }, context), { status: 403 });
    assert.ok(await app.harness.conversation(id, context));
    await app.harness.commit(async (tx) => { delete (await tx.doc(SessionsDoc)).items[String(id)]!.pip; }, context);
    await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "owner-now" }, context);
    app.config.removeUser(guest.id);
    app.config.removeUser(viewer.id);
});

test("scope revisions ignore output/document changes but a new true subagent invalidates preview without stopping", async () => {
    const id = await newSession(app);
    const preview = await app.sessionCleanup.plan(owner(app), [Number(id)], context);
    await notes(id, "counts may change");
    assert.equal((await app.sessionCleanup.plan(owner(app), [Number(id)], context)).revision, preview.revision);
    const child = await ownedChild(id);
    await assert.rejects(app.sessionCleanup.delete(owner(app), { ids: [Number(id)], revision: preview.revision, requestId: "stale-tree" }, context), {
        status: 409, message: "Session cleanup preview is stale. Preview again before deleting.",
    });
    assert.ok(await app.harness.conversation(id, context));
    assert.ok(await app.harness.conversation(child.id, context));
    assert.equal((await app.harness.snapshot(SessionCleanupReceiptsDoc, context))?.items.some((item) => item.requestId === "stale-tree"), false);
    await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "fresh-tree" }, context);
});

test("live background groups and escaped/pruned marked daemons stop, while unrelated work and project files survive", { skip: !existsSync("/proc/self/stat") }, async () => {
    const id = await newSession(app);
    const kept = await newSession(app);
    backgrounds.add(id);
    backgrounds.add(kept);
    const projectFile = join(work, "cleanup-preserves-project.txt");
    writeFileSync(projectFile, "project sentinel");
    await app.background.start(id, { command: "sleep 300 & wait", notify: false });
    await app.background.start(kept, { command: "sleep 300", notify: false });
    await until(() => liveMarkedProcesses(id).length > 0 && liveMarkedProcesses(kept).length > 0, "owned background processes");
    // A pruned ended record must not hide a surviving native marked process from cleanup.
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(BackgroundDoc, id);
        for (const key of Object.keys(doc.items)) delete doc.items[key];
    }, context);
    const result = await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "live-background" }, context);
    assert.equal(result.status, "deleted");
    assert.equal(liveMarkedProcesses(id).length, 0);
    assert.ok(liveMarkedProcesses(kept).length > 0, "unrelated background remains alive");
    assert.equal(readFileSync(projectFile, "utf8"), "project sentinel");
    assert.equal(existsSync(join(dataDir, "background", String(id))), false);
});

test("one accepted operation rejects concurrent cleanup and new background admission; request abort cannot hide a successful purge", { skip: !existsSync("/proc/self/stat") }, async () => {
    const id = await newSession(app);
    backgrounds.add(id);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
    app.background.beforeSpawn = async () => { markEntered(); await held; };
    const start = app.background.start(id, { command: "sleep 300", notify: false });
    const startFailure = start.catch((error: unknown) => error);
    await entered;
    const abort = new AbortController();
    const deleting = app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "abort-after-seal" }, withAbortSignal(abort.signal, context));
    try {
        await until(() => app.sessionCleanup.isDeleting(id), "native accepted cleanup seal");
        await assert.rejects(app.sessionCleanup.plan(owner(app), [Number(id)], context), { status: 409 });
        await assert.rejects(app.background.start(id, { command: "sleep 300" }), { status: 409 });
        await assert.rejects(app.commands.fork(id, owner(app), {}), { status: 409 });
        abort.abort(new Error("browser disconnected"));
        release();
        const result = await deleting;
        assert.equal(result.status, "deleted");
        assert.equal(await app.harness.conversation(id, context), undefined);
        assert.ok(await startFailure instanceof Error);
        assert.equal(liveMarkedProcesses(id).length, 0);
        assert.equal((await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "abort-after-seal" }, context)).status, "already_deleted");
    } finally {
        release();
        app.background.beforeSpawn = undefined;
        await startFailure;
        await deleting.catch(() => undefined);
    }
});

test("post-purge auxiliary errors are honest durable outcomes, and cleanup preserves unowned files", async () => {
    const id = await newSession(app);
    const folder = join(dataDir, "background", String(id));
    mkdirSync(folder, { recursive: true });
    const unknown = join(folder, "unowned-project.txt");
    writeFileSync(unknown, "must preserve");
    const request = { ids: [Number(id)], requestId: "auxiliary-warning" };
    const result = await app.sessionCleanup.delete(owner(app), request, context);
    assert.equal(result.status, "deleted");
    assert.ok(result.warnings.some((warning) => warning.startsWith("Background logs cleanup failed after storage deletion:")));
    assert.equal(readFileSync(unknown, "utf8"), "must preserve");
    assert.equal(await app.harness.conversation(id, context), undefined);
    assert.deepEqual(await app.sessionCleanup.delete(owner(app), request, context), { ...result, status: "already_deleted" });
    await app.close();
    app = await openApp(model, dataDir);
    assert.deepEqual(await app.sessionCleanup.delete(owner(app), request, context), { ...result, status: "already_deleted" });
});

test("a revoked actor during stopping leaves purge, metadata and receipt uncommitted", { skip: !existsSync("/proc/self/stat") }, async () => {
    const id = await newSession(app);
    backgrounds.add(id);
    const actor = { ...owner(app) };
    const originalHash = owner(app).tokenHash;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
    app.background.beforeSpawn = async () => { markEntered(); await held; };
    const start = app.background.start(id, { command: "sleep 300", notify: false }).catch((error: unknown) => error);
    await entered;
    const deleting = app.sessionCleanup.delete(actor, { ids: [Number(id)], requestId: "revoked-during-stop" }, context);
    const denial = assert.rejects(deleting, { status: 403 });
    try {
        await until(() => app.sessionCleanup.isDeleting(id), "accepted seal before revocation");
        owner(app).tokenHash = "disposable-test-revocation";
        release();
        await denial;
        assert.ok(await app.harness.conversation(id, context));
        assert.ok((await app.harness.snapshot(SessionsDoc, context))?.items[String(id)]);
        assert.equal((await app.harness.snapshot(SessionCleanupReceiptsDoc, context))?.items.some((item) => item.requestId === "revoked-during-stop"), false);
    } finally {
        owner(app).tokenHash = originalHash;
        release();
        app.background.beforeSpawn = undefined;
        await start;
        await deleting.catch(() => undefined);
    }
    await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "revocation-restored" }, context);
});

test("request keys bind the explicit roots and completed native receipts stay bounded at twenty", async () => {
    const id = await newSession(app);
    const other = await newSession(app);
    await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "root-bound-key" }, context);
    await assert.rejects(app.sessionCleanup.delete(owner(app), { ids: [Number(other)], requestId: "root-bound-key" }, context), { status: 409 });
    assert.ok(await app.harness.conversation(other, context));
    for (let index = 0; index < 21; index++) {
        const fresh = await newSession(app);
        await app.sessionCleanup.delete(owner(app), { ids: [Number(fresh)], requestId: `bounded-${index}` }, context);
    }
    const receipts = (await app.harness.snapshot(SessionCleanupReceiptsDoc, context))!.items;
    assert.equal(receipts.length, 20);
    assert.equal(receipts[0]!.requestId, "bounded-1");
    assert.equal(receipts.at(-1)!.requestId, "bounded-20");
});

test("goal checks outside durable tasks are terminated before native deletion", { skip: !existsSync("/proc/self/stat") }, async () => {
    const id = await newSession(app);
    const pidFile = join(root, "cleanup-goal.pid");
    const check = app.goals.run(id, `printf '%s' "$$" > ${JSON.stringify(pidFile)}; sleep 300`, context).catch((error: unknown) => error);
    try {
        await until(() => existsSync(pidFile), "owned external goal process");
        const pid = Number(readFileSync(pidFile, "utf8"));
        await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "external-goal" }, context);
        await check;
        let running = false;
        try { running = !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { /* process exited */ }
        assert.equal(running, false);
        assert.equal(await app.harness.conversation(id, context), undefined);
    } finally {
        await app.goals.prepareSessionDeletion([id]);
        await check;
    }
});

test("a symlink replacing a native background folder never authorizes deleting project logs", async () => {
    const id = await newSession(app);
    const project = join(work, "cleanup-linked-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "ownedlooking.log"), "shared project log");
    mkdirSync(join(dataDir, "background"), { recursive: true });
    symlinkSync(project, join(dataDir, "background", String(id)), "dir");
    const result = await app.sessionCleanup.delete(owner(app), { ids: [Number(id)], requestId: "preserve-linked-logs" }, context);
    assert.equal(result.status, "deleted");
    assert.ok(result.warnings.some((warning) => warning.includes("not an owned native directory")));
    assert.equal(readFileSync(join(project, "ownedlooking.log"), "utf8"), "shared project log");
});
