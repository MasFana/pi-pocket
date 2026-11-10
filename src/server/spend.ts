/**
 * What Pi costs, and limits on it. A conversation's spend is its `pi.usage` total; a session's is its own and its
 * subagents'. Spend is also counted per person: work goes to whoever asked for it, the person Pi works for there when
 * the work's usage is committed. The owner can limit a session or a person. Past a limit, new messages are refused,
 * and a run that crosses it is stopped; the model request that crossed it still counts.
 */
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { type ConversationId, type Tx, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionsDoc, SpendDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { usageCost } from "./projection.ts";

const context = BACKGROUND_CONTEXT;

/** Spend stored for people a little after it happens: a run commits its usage with every response. */
const COUNT_AFTER_MS = 250;

export const dollars = (amount: number) => `$${amount.toFixed(2)}`;

export type SpendSummary = {
    /** Everything Pi spent on this server; only the owner sees it. */
    total?: number;
    sessions: { id: number; title: string; spent: number; budget?: number }[];
    /** Everyone for the owner; others see themselves. */
    people: { id: string; name: string; spent: number; budget?: number }[];
};

export class Spend {
    readonly #app: PocketApp;
    /** Each conversation's spend so far. */
    readonly #costs = new Map<ConversationId, number>();
    /** Spend added to people but not stored yet, per conversation and person. */
    readonly #owed = new Map<ConversationId, Map<string, number>>();
    /** What `SpendDoc` says each person spent, as of the last count. */
    #people: Record<string, number> = {};
    /** Runs being stopped for a limit, until they end: each is stopped, and announced, once. */
    readonly #stopping = new Set<ConversationId>();
    #timer: NodeJS.Timeout | undefined;
    /** Told when the owner changes a limit: work held back by one may go now. */
    readonly #limits = new Set<() => void>();
    /** Counting and usage writes already admitted, drained before the native purge. */
    readonly #writes = new Map<ConversationId, Set<Promise<void>>>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #available(id: ConversationId): boolean {
        try {
            this.#app.sessionCleanup.assertAvailable(id);
            return true;
        } catch (error) {
            if (error instanceof HttpError && (error.status === 409 || error.status === 404)) {
                return false;
            }

            throw error;
        }
    }

    #trackWrite(ids: readonly ConversationId[], pending: Promise<void>): Promise<void> {
        const tracked = pending.finally(() => {
            for (const id of ids) {
                const writes = this.#writes.get(id);
                writes?.delete(tracked);

                if (writes?.size === 0) {
                    this.#writes.delete(id);
                }
            }
        });

        for (const id of ids) {
            const writes = this.#writes.get(id) ?? new Set<Promise<void>>();
            writes.add(tracked);
            this.#writes.set(id, writes);
        }

        return tracked;
    }

    /** Drain admitted accounting writes after sealing, so the purge owns the remaining selected debt. */
    async prepareSessionDeletion(ids: readonly ConversationId[]): Promise<void> {
        const writes = new Set<Promise<void>>();

        for (const id of ids) {
            // A newly created conversation may not have reported usage yet. Its native abort can still report cost.
            if (!this.#costs.has(id)) {
                this.#costs.set(id, 0);
            }

            for (const pending of this.#writes.get(id) ?? []) {
                writes.add(pending);
            }
        }

        await Promise.allSettled(writes);
    }

    /** In the native purge transaction, retain accrued people spend but remove selected counted identities. */
    async pruneSessionDeletion(tx: Tx, ids: readonly ConversationId[]): Promise<void> {
        const doc = await tx.doc(SpendDoc);

        for (const id of new Set(ids)) {
            for (const [payer, added] of this.#owed.get(id) ?? []) {
                doc.people[payer] = (doc.people[payer] ?? 0) + added;
            }

            delete doc.counted[String(id)];
        }
        // Debt stays in memory until the purge commits: a failed transaction must not lose it.
    }

    /** After purge commits, drop only its conversation costs, pending debt, and stop markers. */
    forgetSessions(ids: readonly ConversationId[]): void {
        for (const id of ids) {
            this.#costs.delete(id);
            this.#owed.delete(id);
            this.#stopping.delete(id);
        }

        if (this.#owed.size === 0) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }
    }

    /**
     * Start from what is stored: every conversation's spend, then count what a crash left uncounted. That goes to whoever
     * Pi works for there now, as whom it was for is not stored.
     */
    async load(ids: readonly ConversationId[]): Promise<void> {
        const harness = this.#app.harness;

        for (const id of ids) {
            if (!this.#available(id)) {
                continue;
            }

            const cost = usageCost(await harness.snapshot(UsageDoc, id, context));

            if (this.#available(id)) {
                this.#costs.set(id, cost);
            }
        }

        if ((await harness.snapshot(SpendDoc, context)) === undefined) {
            // The first start that counts spend per person: what was spent before is nobody's, rather than all of it
            // going to whoever wrote last in each conversation.
            await this.#trackWrite([...this.#costs.keys()], harness.commit(async (tx) => {
                const doc = await tx.doc(SpendDoc);

                for (const [id, cost] of this.#costs) {
                    if (this.#available(id)) {
                        doc.counted[String(id)] = cost;
                    }
                }
            }, context));
        }

        const stored = await harness.snapshot(SpendDoc, context);

        this.#people = { ...stored?.people };

        for (const id of ids) {
            const added = (this.#costs.get(id) ?? 0) - (stored?.counted[String(id)] ?? 0);

            if (added > 0) {
                this.#owe(id, this.payer(id), added);
            }
        }

        await this.#count();
        const counted = await harness.snapshot(SpendDoc, context);

        this.#people = { ...counted?.people };
        this.#stopOverLimit();
    }

    /** Add spend in a conversation to a person, to be stored with the next count. */
    #owe(id: ConversationId, payer: string, added: number): void {
        if (!this.#acceptsUsage(id)) {
            return;
        }

        const owed = this.#owed.get(id) ?? new Map<string, number>();

        owed.set(payer, (owed.get(payer) ?? 0) + added);
        this.#owed.set(id, owed);
    }

    #acceptsUsage(id: ConversationId): boolean {
        // Final usage while stopping a sealed conversation still costs its people. Once forgotten, its absent cost
        // cache also blocks late commit notifications during the remaining sealed post-purge window.
        return this.#available(id) || (this.#app.sessionCleanup.isDeleting(id) && this.#costs.has(id));
    }

    /** A count sealed out by cleanup still owes its people, until the purge transaction pays them. */
    #restoreOwed(id: ConversationId, payers: ReadonlyMap<string, number>): void {
        if (!this.#acceptsUsage(id)) {
            return;
        }

        const owed = this.#owed.get(id) ?? new Map<string, number>();

        for (const [payer, added] of payers) {
            owed.set(payer, (owed.get(payer) ?? 0) + added);
        }

        this.#owed.set(id, owed);
    }

    /**
     * A conversation's usage changed: called from the commit listener, when whom Pi works for is who asked for this
     * work. Storing it waits for a moment.
     */
    usageChanged(id: ConversationId, usage: UsageState | null, alreadyPaid = false): void {
        if (!this.#acceptsUsage(id)) {
            return;
        }

        const cost = usageCost(usage ?? undefined);
        // An auxiliary request pays all its usage in this commit. Do not infer another debt from rounded totals.
        const added = alreadyPaid ? 0 : cost - (this.#costs.get(id) ?? 0);

        this.#costs.set(id, cost);

        if (added > 0) {
            this.#owe(id, this.payer(id), added);
        }

        if (this.#app.sessionCleanup.isDeleting(id)) {
            return;
        }

        this.#timer ??= setTimeout(() => {
            this.#timer = undefined;
            void this.#count().catch((error: unknown) =>
                this.#app.log(`spend not counted: ${describe(error)}`),
            );
        }, COUNT_AFTER_MS);
    }

    /** Follow stored spend, including auxiliary requests that pay their captured person atomically. */
    countedChanged(stored: { people: Record<string, number> }): void {
        this.#people = { ...stored.people };
    }

    /** Record an auxiliary model request with its captured payer, even if another run has started since. */
    async recordModelUsage(
        id: ConversationId,
        payer: string,
        message: AssistantMessage,
    ): Promise<void> {
        this.#app.sessionCleanup.assertAvailable(id);
        await this.#trackWrite([id], this.#app.harness.commit(async (tx) => {
            this.#app.sessionCleanup.assertAvailable(id);
            const models = (await tx.doc(UsageDoc, id)).models as Record<string, Usage>;
            this.#app.sessionCleanup.assertAvailable(id);
            const key = `${message.provider}/${message.model}`;
            const usage = message.usage;
            const total = Object.hasOwn(models, key) ? models[key] : undefined;

            if (total === undefined) {
                // The provider/model key contains a slash, so it cannot be a prototype setter.
                models[key] = copyJson(usage, {
                    omitUndefinedProperties: true,
                }) as unknown as Usage;
            } else {
                for (const field of [
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "totalTokens",
                ] as const) {
                    total[field] += usage[field];
                }

                for (const field of ["cacheWrite1h", "reasoning"] as const) {
                    if (usage[field] !== undefined) {
                        total[field] = (total[field] ?? 0) + usage[field];
                    }
                }

                for (const field of [
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "total",
                ] as const) {
                    total.cost[field] += usage.cost[field];
                }
            }

            // Atomic with usage: a restart cannot lose the payer or charge this request twice.
            const spend = await tx.doc(SpendDoc);
            this.#app.sessionCleanup.assertAvailable(id);

            spend.counted[String(id)] = (spend.counted[String(id)] ?? 0) + usage.cost.total;
            spend.people[payer] = (spend.people[payer] ?? 0) + usage.cost.total;
        }, context));
        this.#stopOverLimit();
    }

    /** Who pays for a conversation's work: whoever asked for it, else whoever started the session, else the owner. */
    payer(id: ConversationId): string {
        const app = this.#app;

        return (
            app.attribution.requesterOf(id) ??
            app.sessionMeta(app.rootOf(id))?.createdBy ??
            app.config.users.find((user) => user.role === "owner")!.id
        );
    }

    /** Store available conversations' spend; sealed debt is paid by the native purge instead. */
    async #count(): Promise<void> {
        const owed = [...this.#owed].filter(([id]) => this.#available(id));

        if (owed.length === 0) {
            return;
        }

        for (const [id] of owed) {
            this.#owed.delete(id);
        }

        await this.#trackWrite(owed.map(([id]) => id), (async () => {
            const deferred = new Map<ConversationId, Map<string, number>>();

            try {
                await this.#app.harness.commit(async (tx) => {
                    const doc = await tx.doc(SpendDoc);
                    deferred.clear();

                    for (const [id, payers] of owed) {
                        if (!this.#available(id)) {
                            deferred.set(id, payers);
                            continue;
                        }

                        for (const [payer, added] of payers) {
                            doc.counted[String(id)] = (doc.counted[String(id)] ?? 0) + added;
                            doc.people[payer] = (doc.people[payer] ?? 0) + added;
                        }
                    }
                }, context);
            } catch (error) {
                for (const [id, payers] of owed) {
                    this.#restoreOwed(id, payers);
                }

                throw error;
            }

            for (const [id, payers] of deferred) {
                this.#restoreOwed(id, payers);
            }

            this.#stopOverLimit();
        })());
    }

    /** What one conversation spent, its subagents not counted: a subagent's own cost. */
    conversationSpent(id: ConversationId): number {
        return this.#costs.get(id) ?? 0;
    }

    /** What a session spent: itself and its subagents. */
    sessionSpent(root: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#costs) {
            if (this.#app.rootOf(id) === root) {
                spent += cost;
            }
        }

        return spent;
    }

    /**
     * The session at the top of a linked family (`linked-sessions.ts`): the one that started this one, and so on up. A
     * session no link started is its own.
     */
    teamRoot(root: ConversationId): ConversationId {
        const seen = new Set<ConversationId>([root]);
        let at = root;

        for (;;) {
            const from = this.#app.sessionMeta(at)?.linkedFrom?.id as ConversationId | undefined;

            if (from === undefined || seen.has(from)) {
                return at;
            }

            seen.add(from);
            at = from;
        }
    }

    /** What a linked family spent: its top session and every session linked under it, subagents included. */
    #teamSpent(top: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#costs) {
            if (this.teamRoot(this.#app.rootOf(id)) === top) {
                spent += cost;
            }
        }

        return spent;
    }

    /**
     * What counts against a session's own limit, to show beside it: itself and its subagents, and, for a session that
     * started linked sessions, theirs too, as `#reached` counts it.
     */
    budgetSpent(root: ConversationId): number {
        return this.teamRoot(root) === root ? this.#teamSpent(root) : this.sessionSpent(root);
    }

    personSpent(userId: string): number {
        return this.#people[userId] ?? 0;
    }

    /** The limit work in a conversation reached when `userId` pays for it: the session's, or theirs. */
    #reached(
        id: ConversationId,
        userId: string,
    ): { budget: number; person?: User; team?: true } | undefined {
        const app = this.#app;
        const root = app.rootOf(id);
        const budget = app.sessionMeta(root)?.budget;

        if (budget !== undefined && this.sessionSpent(root) >= budget) {
            return { budget };
        }

        // The budget of the session that started a team covers it all: what its linked sessions spend counts too.
        const top = this.teamRoot(root);
        const team = app.sessionMeta(top)?.budget;

        if (team !== undefined && this.#teamSpent(top) >= team) {
            return top === root ? { budget: team } : { budget: team, team: true };
        }

        const person = app.config.userById(userId);
        const limit = person === undefined || person.role === "owner" ? undefined : person.budget;

        if (limit !== undefined && this.personSpent(userId) >= limit) {
            return { budget: limit, person };
        }

        return undefined;
    }

    /** Throw unless this person may start more work in this session. */
    check(user: User, id: ConversationId): void {
        const reached = this.#reached(id, user.id);

        if (reached === undefined) {
            return;
        }

        const whose =
            reached.person !== undefined
                ? "You reached your"
                : reached.team
                  ? "The session that started this one reached its"
                  : "This session reached its";

        throw new HttpError(
            409,
            `${whose} ${dollars(reached.budget)} spend limit. The owner can raise it.`,
        );
    }

    /**
     * Why work Pi starts with nobody asking (a scheduled message, the next round toward a goal) may not start: a limit
     * the session or its payer reached. `userId` pays when given, else whoever asked last.
     */
    heldBack(id: ConversationId, userId = this.payer(id)): string | undefined {
        const reached = this.#reached(id, userId);

        if (reached === undefined) {
            return undefined;
        }

        return reached.person !== undefined
            ? `${reached.person.name} reached their ${dollars(reached.budget)} spend limit`
            : reached.team
              ? `the session that started this one reached its ${dollars(reached.budget)} spend limit`
              : `this session reached its ${dollars(reached.budget)} spend limit`;
    }

    /** Call `listener` whenever the owner changes a session's or a person's limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void {
        this.#limits.add(listener);

        return () => this.#limits.delete(listener);
    }

    #limitsChanged(): void {
        for (const listener of this.#limits) {
            listener();
        }
    }

    /** A conversation's run ended: a new one there is stopped again if it goes past a limit. */
    runEnded(id: ConversationId): void {
        this.#stopping.delete(id);
    }

    /** Stop every run that goes on past its session's limit or its payer's. */
    #stopOverLimit(): void {
        const app = this.#app;

        for (const id of app.busyConversations()) {
            if (!this.#available(id) || this.#stopping.has(id)) {
                continue;
            }

            const why = this.heldBack(id);

            if (why === undefined) {
                continue;
            }

            this.#stopping.add(id);
            app.notice("warning", `Pi stopped: ${why}.`, id);
            void app
                .conversation(id)
                .then((conversation) => this.#available(id) ? conversation.abort(context) : undefined)
                .catch((error: unknown) => {
                    // The next count tries again.
                    this.#stopping.delete(id);
                    if (!this.#available(id)) {
                        return;
                    }

                    app.log(`could not stop ${String(id)}: ${describe(error)}`);
                });
        }
    }

    /** The owner limits what Pi may spend in a session (`null`: no limit). */
    async setSessionBudget(user: User, id: ConversationId, budget: unknown): Promise<void> {
        requireOwner(user);
        this.#app.sessionCleanup.assertAvailable(id);
        const amount = budgetOf(budget);

        await this.#trackWrite([id], this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];
            this.#app.sessionCleanup.assertAvailable(id);

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            if (amount === undefined) {
                delete meta.budget;
            } else {
                meta.budget = amount;
            }
        }, context));
        this.#limitsChanged();
        await this.#app.collab.activity(
            id,
            user,
            amount === undefined
                ? "removed the spend limit"
                : `set a spend limit of ${dollars(amount)}`,
        );
    }

    /** The owner limits what Pi may spend for a person (`null`: no limit). */
    setPersonBudget(user: User, userId: string, budget: unknown): void {
        requireOwner(user);
        const person = this.#app.config.userById(userId);

        if (person === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (person.role === "owner") {
            throw new HttpError(400, "The owner has no spend limit");
        }

        const amount = budgetOf(budget);

        this.#app.config.updateUser(userId, { budget: amount });
        this.#limitsChanged();
    }

    /** Spend as this person may see it: the owner sees everything, others their own sessions and themselves. */
    summary(user: User): SpendSummary {
        const app = this.#app;
        const owner = user.role === "owner";
        // Each session's spend, its subagents' with it, in one pass over every conversation.
        const byRoot = new Map<ConversationId, number>();

        for (const [id, cost] of this.#costs) {
            const root = app.rootOf(id);

            byRoot.set(root, (byRoot.get(root) ?? 0) + cost);
        }

        const sessions = app.sessions(user).map((session) => {
            const id = session.id as unknown as ConversationId;
            const budget = app.sessionMeta(id)?.budget;

            return {
                id: session.id,
                title: session.title ?? "New session",
                spent: budget === undefined ? (byRoot.get(id) ?? 0) : this.budgetSpent(id),
                ...(budget === undefined ? {} : { budget }),
            };
        });
        // PiP is out of the session list, not out of the spending: its person sees what it cost.
        const pip = app.pip.idOf(user.id);

        if (pip !== undefined) {
            // With its limit, like any session's: the owner sees it, and can clear it.
            const budget = app.sessionMeta(pip)?.budget;

            sessions.push({
                id: Number(pip),
                title: "PiP",
                spent: byRoot.get(pip) ?? 0,
                ...(budget === undefined ? {} : { budget }),
            });
        }

        const people = app.config.users
            .filter((person) => owner || person.id === user.id)
            .map((person) => ({
                id: person.id,
                name: person.name,
                spent: this.personSpent(person.id),
                ...(person.budget === undefined ? {} : { budget: person.budget }),
            }));
        const total = [...this.#costs.values()].reduce((sum, cost) => sum + cost, 0);

        return {
            ...(owner ? { total } : {}),
            sessions: sessions.sort((a, b) => b.spent - a.spent),
            people: people.sort((a, b) => b.spent - a.spent),
        };
    }

    close(): void {
        clearTimeout(this.#timer);
        this.#limits.clear();
    }
}

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can do that");
    }
}

/** A limit from a request: dollars, or null for none. */
function budgetOf(value: unknown): number | undefined {
    if (value === null) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        throw new HttpError(400, "budget must be an amount in dollars, or null for none");
    }

    return Math.round(value * 100) / 100;
}
