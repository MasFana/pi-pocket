import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
    type ConversationDeletionPlan,
    type ConversationId,
    defineDoc,
    ROOT_CONVERSATION_ID,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    ArtifactSharesDoc,
    HooksDoc,
    PublicLinksDoc,
    RepoWatchesDoc,
    SessionsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";

export type SessionDeletionPreview = {
    ids: number[];
    revision: string;
    roots: { id: number; title: string; cwd: string }[];
    conversations: number;
    subagents: number;
    tasks: number;
    submissions: number;
    documents: number;
    entries: number;
    retainedSharedEntries: number;
};

export type SessionDeletionOutcome = {
    status: "deleted" | "already_deleted";
    /** Explicit selected roots, not the native ownership closure. */
    ids: number[];
    conversations: number;
    subagents: number;
    tasks: number;
    submissions: number;
    documents: number;
    entries: number;
    retainedSharedEntries: number;
    warnings: string[];
};

type Receipt = {
    actor: string;
    requestId: string;
    at: number;
    outcome: SessionDeletionOutcome;
};

/** Native receipts contain no transcripts, titles, paths, or credentials. */
export const SessionCleanupReceiptsDoc = defineDoc<{ items: Receipt[] }>({
    kind: "pocket.session-cleanup-receipts",
    version: 1,
    scope: "session",
    checkpointWhen: () => true,
    initial: () => ({ items: [] }),
});

const MAX_ROOTS = 50;
const MAX_CONVERSATIONS = 5000;
const MAX_RECEIPTS = 20;
const BUSY = "Session cleanup is already in progress. Retry with the same requestId.";
const STALE = "Session cleanup preview is stale. Preview again before deleting.";

function selected(ids: readonly number[]): number[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ROOTS) {
        throw new HttpError(400, `Select between 1 and ${MAX_ROOTS} sessions.`);
    }
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new HttpError(400, "Session IDs must be positive safe integers; session 0 is protected.");
    }
    if (ids.includes(Number(ROOT_CONVERSATION_ID))) {
        throw new HttpError(403, "The native reserved root conversation cannot be deleted.");
    }
    return [...new Set(ids)].sort((a, b) => a - b);
}

function cleanupError(error: unknown): never {
    if (error instanceof Error) {
        if (error.name === "ConversationDeletionConflict") throw new HttpError(409, STALE);
        if (error.name === "ConversationDeletionBusy") throw new HttpError(409, BUSY);
        if (error.name === "ConversationDeletionUnsupported") throw new HttpError(501, error.message);
    }
    throw error;
}

function counts(plan: ConversationDeletionPlan, roots: readonly number[]) {
    return {
        conversations: plan.conversationIds.length,
        subagents: plan.conversationIds.length - roots.length,
        tasks: plan.tasks,
        submissions: plan.submissions,
        documents: plan.documents,
        entries: plan.entries,
        retainedSharedEntries: plan.retainedSharedEntries,
    };
}

/** Owner administration only. Admission stays sealed until mandatory post-purge cleanup finishes. */
export class SessionCleanup {
    readonly #app: PocketApp;
    #inFlight = false;
    readonly #deleting = new Set<ConversationId>();
    readonly #deleted = new Set<ConversationId>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    isDeleting(id: ConversationId): boolean {
        return this.#deleting.has(id);
    }

    assertAvailable(id: ConversationId): void {
        if (this.#deleting.has(id)) {
            throw new HttpError(409, "This session is being deleted.");
        }
        if (this.#deleted.has(id)) {
            throw new HttpError(404, "This session was deleted.");
        }
    }

    #owner(user: User): void {
        const current = this.#app.config.userById(user.id);
        if (
            user.role !== "owner" || current?.role !== "owner" ||
            current.tokenHash !== user.tokenHash
        ) {
            throw new HttpError(403, "Only the current owner can delete sessions.");
        }
    }

    #enter(user: User, context: Context): void {
        this.#owner(user);
        context.abortSignal?.throwIfAborted();
        if (this.#inFlight) {
            throw new HttpError(409, BUSY);
        }
        this.#inFlight = true;
    }

    async #roots(user: User, ids: readonly number[], context: Context) {
        const roots = await this.#app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const roots: SessionDeletionPreview["roots"] = [];
            for (const number of ids) {
                const id = number as ConversationId;
                const record = await tx.conversation(id);
                this.#owner(user);
                const meta = sessions.items[String(number)];
                if (record === undefined || meta === undefined) {
                    throw new HttpError(404, `Session ${number} does not exist.`);
                }
                if (record.owner !== undefined) {
                    throw new HttpError(400, `Conversation ${number} is not a top-level session.`);
                }
                if (number === 0 || meta.pip !== undefined) {
                    throw new HttpError(403, "PiP and session 0 cannot be deleted.");
                }
                roots.push({ id: number, title: meta.title ?? "New session", cwd: meta.cwd });
            }
            return roots;
        }, context);
        this.#owner(user);
        return roots;
    }

    #cap(plan: ConversationDeletionPlan): void {
        if (plan.conversationIds.length > MAX_CONVERSATIONS) {
            throw new HttpError(413, `Cleanup is limited to ${MAX_CONVERSATIONS} conversations.`);
        }
    }

    async plan(user: User, requested: readonly number[], context: Context): Promise<SessionDeletionPreview> {
        this.#enter(user, context);
        try {
            const ids = selected(requested);
            const roots = await this.#roots(user, ids, context);
            const plan = await this.#app.harness.planConversationDeletion(ids as ConversationId[], context);
            this.#owner(user);
            this.#cap(plan);
            return { ids, roots, revision: plan.revision, ...counts(plan, ids) };
        } catch (error) {
            cleanupError(error);
        } finally {
            this.#inFlight = false;
        }
    }

    async #receipt(user: User, ids: readonly number[], requestId: string, context: Context) {
        const doc = await this.#app.harness.snapshot(SessionCleanupReceiptsDoc, context);
        this.#owner(user);
        const receipt = doc?.items.find((item) => item.actor === user.id && item.requestId === requestId);
        if (receipt === undefined) {
            return undefined;
        }
        if (receipt.outcome.ids.join(",") !== ids.join(",")) {
            throw new HttpError(409, "This cleanup requestId was already used for different sessions.");
        }
        return { ...receipt.outcome, ids: [...receipt.outcome.ids], warnings: [...receipt.outcome.warnings], status: "already_deleted" as const };
    }

    /** Global participant metadata and the receipt are changed only inside the purge transaction. */
    async #metadata(tx: Tx, scope: readonly ConversationId[]): Promise<void> {
        const ids = new Set(scope.map(Number));
        const sessions = await tx.doc(SessionsDoc);
        for (const id of ids) {
            delete sessions.items[String(id)];
        }
        const hooks = await tx.doc(HooksDoc);
        for (const [key, item] of Object.entries(hooks.items)) {
            if (ids.has(item.target)) delete hooks.items[key];
        }
        const watches = await tx.doc(RepoWatchesDoc);
        for (const [key, item] of Object.entries(watches.items)) {
            if (ids.has(item.target)) delete watches.items[key];
        }
        const shares = await tx.doc(ArtifactSharesDoc);
        for (const [key, item] of Object.entries(shares.items)) {
            if (ids.has(Number(item.conversation))) delete shares.items[key];
        }
        const links = await tx.doc(PublicLinksDoc);
        for (const [key, item] of Object.entries(links.items)) {
            if (item.conversation !== undefined && ids.has(item.conversation)) delete links.items[key];
        }
        await this.#app.spend.pruneSessionDeletion(tx, scope);
    }

    async delete(
        user: User,
        request: { ids: readonly number[]; revision?: string; requestId: string },
        context: Context,
    ): Promise<SessionDeletionOutcome> {
        this.#enter(user, context);
        let scope: readonly ConversationId[] = [];
        let purged = false;
        const admin = withoutAbortSignal(context);
        try {
            if (request === null || typeof request !== "object" ||
                typeof request.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.requestId) ||
                (request.revision !== undefined && (typeof request.revision !== "string" || request.revision.length > 100_000))) {
                throw new HttpError(400, "A requestId of 1–64 letters, digits, hyphens, or underscores and an optional revision are required.");
            }
            const ids = selected(request.ids);
            const known = await this.#receipt(user, ids, request.requestId, context);
            if (known !== undefined) return known;
            await this.#roots(user, ids, context);
            const preview = await this.#app.harness.planConversationDeletion(ids as ConversationId[], context);
            this.#owner(user);
            this.#cap(preview);
            if (request.revision !== undefined && request.revision !== preview.revision) {
                throw new HttpError(409, STALE);
            }
            let outcome: SessionDeletionOutcome | undefined;
            const result = await this.#app.harness.deleteConversations(ids as ConversationId[], context, {
                // Even direct deletion is bound to the fresh tree read above, before any stop effects.
                expectedRevision: preview.revision,
                beforeStop: async (plan) => {
                    this.#owner(user);
                    this.#cap(plan);
                    scope = plan.conversationIds;
                    for (const id of scope) this.#deleting.add(id);
                    await this.#app.alerts.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.limits.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.collab.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.goals.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.background.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.hooks.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.repoWatches.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.attribution.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.spend.prepareSessionDeletion(scope);
                    this.#owner(user);
                    await this.#app.browsers.prepareSessionDeletion(scope.map(Number));
                    this.#owner(user);
                },
                beforeDelete: async (tx, plan) => {
                    this.#owner(user);
                    this.#cap(plan);
                    // Revalidate persisted identities before the transaction stages any participant removals.
                    for (const number of ids) {
                        const record = await tx.conversation(number as ConversationId);
                        this.#owner(user);
                        if (record === undefined || record.owner !== undefined) {
                            throw new HttpError(409, "A selected root is no longer a top-level session.");
                        }
                    }
                    const sessions = await tx.doc(SessionsDoc);
                    this.#owner(user);
                    for (const number of ids) {
                        const meta = sessions.items[String(number)];
                        if (meta === undefined || meta.pip !== undefined) {
                            throw new HttpError(409, "A selected session is missing or protected.");
                        }
                    }
                    await this.#metadata(tx, plan.conversationIds);
                    this.#owner(user);
                    outcome = {
                        status: "deleted", ids, ...counts(plan, ids),
                        warnings: [
                            "Project folders, worktrees, branches, uploaded files and shared assets were preserved; exclusive session ownership is not recorded for those files.",
                            "Already-delivered notifications and external effects cannot be recalled; extension callbacks receive cooperative cancellation.",
                            ...(plan.retainedSharedEntries > 0 ? ["History needed by surviving forks was retained."] : []),
                        ],
                    };
                    const receipts = await tx.doc(SessionCleanupReceiptsDoc);
                    this.#owner(user);
                    receipts.items.push({ actor: user.id, requestId: request.requestId, at: this.#app.now(), outcome });
                    receipts.items.splice(0, Math.max(0, receipts.items.length - MAX_RECEIPTS));
                },
            });
            purged = true;
            // The callback's receipt is mandatory, not a guessed success when a backend did not call it.
            if (outcome === undefined) throw new Error("Native deletion did not commit its required receipt.");
            Object.assign(outcome, counts(result, ids));
            const warnings = outcome.warnings;
            for (const id of result.conversationIds) this.#deleted.add(id);
            const clean = async (name: string, run: () => void | Promise<void>) => {
                try { await run(); } catch (error) {
                    warnings.push(`${name} cleanup failed after storage deletion: ${describe(error)}`);
                }
            };
            await clean("Background logs", () => this.#app.background.finishSessionDeletion(scope));
            await clean("Webhook state", () => this.#app.hooks.finishSessionDeletion());
            await clean("Repository watcher state", () => this.#app.repoWatches.finishSessionDeletion());
            await clean("Extension commands", () => this.#app.extensionCommands.forgetSessions(scope));
            await clean("Shell", () => this.#app.shell.forgetSessions(scope));
            await clean("Attribution", () => this.#app.attribution.forgetSessions(scope));
            await clean("Spend", () => this.#app.spend.forgetSessions(scope));
            await clean("Hidden values", () => this.#app.hidden.forgetSessions(scope));
            await clean("Alerts", () => this.#app.alerts.forgetSessions(scope));
            await clean("Collaboration", () => this.#app.collab.forgetSessions(scope));
            await clean("Provider limits", () => this.#app.limits.forgetSessions(scope));
            await clean("App state", () => this.#app.finishSessionDeletion(result.conversationIds));
            // Auxiliary errors are durable too, so an identical retry reconciles the actual outcome.
            await clean("Receipt update", () => this.#app.harness.commit(async (tx) => {
                const receipts = await tx.doc(SessionCleanupReceiptsDoc);
                const receipt = receipts.items.find((item) => item.actor === user.id && item.requestId === request.requestId);
                if (receipt === undefined) throw new Error("Cleanup receipt disappeared.");
                receipt.outcome = outcome!;
            }, admin));
            return outcome;
        } catch (error) {
            return cleanupError(error);
        } finally {
            // Native publication and post-purge cleanup never use an ended request.
            for (const id of scope) this.#deleting.delete(id);
            if (!purged) {
                this.#app.browsers.releaseSessionDeletion(scope.map(Number));
                this.#app.hooks.releaseSessionDeletion();
                this.#app.repoWatches.releaseSessionDeletion();
            }
            this.#inFlight = false;
        }
    }
}
