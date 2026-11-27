import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { it, mock } from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { realHeadless } from "../src/agent/subagents/headless.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

/** Production entry point, with only process/CDP transport mocked. No process,
 * browser, DNS lookup or socket is actually opened by this fixture. */
function lifecycleFixture() {
	const killed: number[] = [];
	const spawned = deferred(), heldLoad = deferred(), releaseLoad = deferred();
	let pauseHandshake = false, connections = 0, disconnects = 0, disposed = false;
	let failNextConnect = false;
	const helpers: ReturnType<typeof makeHelper>[] = [];
	function makeHelper(id: number) {
		let liveDocument = false, guarded = false;
		const owner = { alive: true, failRetirement: false, holdNextLoad: false, hangNextLoad: false, hangNextEvaluate: false };
		const pendingHangs: Array<() => void> = [];
		const abortHangs = () => {
			for (const rejectHang of pendingHangs.splice(0)) rejectHang();
		};
		const proc = Object.assign(new EventEmitter(), {
			exitCode: null as number | null,
			stdout: new EventEmitter(), stderr: new EventEmitter(),
			kill: () => { killed.push(id); owner.alive = false; proc.exitCode = 0; abortHangs(); return true; },
		});
		const page = Object.assign(new EventEmitter(), {
			target: () => ({ type: () => "page" }), url: () => "about:blank",
			setRequestInterception: async (enabled: boolean) => { guarded = enabled; },
			setContent: async () => {
				assert.equal(owner.alive, true);
				assert.equal(guarded, true);
				liveDocument = true;
				if (owner.hangNextLoad) {
					owner.hangNextLoad = false;
					heldLoad.resolve();
					await new Promise<never>((_, reject) => {
						pendingHangs.push(() => reject(new Error(`killed helper ${id}: setContent`)));
					});
				}
				if (owner.holdNextLoad) { owner.holdNextLoad = false; heldLoad.resolve(); await releaseLoad.promise; }
			},
			evaluate: async () => {
				if (!owner.alive) throw new Error(`dead helper ${id}: evaluate`);
				if (owner.hangNextEvaluate) {
					owner.hangNextEvaluate = false;
					await new Promise<never>((_, reject) => {
						pendingHangs.push(() => reject(new Error(`killed helper ${id}: evaluate`)));
					});
				}
				return "ok";
			},
			goto: async () => {
				if (!owner.alive) throw new Error(`dead helper ${id}: goto`);
				if (liveDocument && owner.failRetirement) throw new Error(`owned retirement failure ${id}`);
				liveDocument = false;
			},
		});
		const browser = {
			pages: async () => {
				if (!owner.alive) throw new Error(`dead helper ${id}: pages`);
				return [page];
			},
			disconnect: async () => { disconnects++; },
		} as unknown as Browser;
		const handshake = () => proc.stdout.emit("data", Buffer.from(`BROWSER_SERVICE_CDP ${46000 + id}\n`));
		return { id, owner, proc, page, browser, handshake, abortHangs, guarded: () => guarded };
	}
	mock.method(childProcess, "spawn", (() => {
		const helper = makeHelper(helpers.length + 1);
		helpers.push(helper);
		spawned.resolve();
		if (!pauseHandshake) queueMicrotask(helper.handshake);
		return helper.proc;
	}) as unknown as typeof childProcess.spawn);
	syncBuiltinESMExports();
	mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
		const id = Number(new URL(String(input)).port) - 46000;
		return new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://owned.invalid/${id}` }));
	});
	mock.method(puppeteer, "connect", async (options: Parameters<typeof puppeteer.connect>[0]) => {
		connections++;
		if (failNextConnect) {
			failNextConnect = false;
			throw new Error("simulated cdp connect failure");
		}
		const id = Number(new URL(options.browserWSEndpoint!).pathname.slice(1));
		return helpers[id - 1]!.browser;
	});
	return {
		helpers, killed, spawned, heldLoad, releaseLoad,
		connections: () => connections,
		disconnects: () => disconnects,
		failNextConnect() { failNextConnect = true; },
		pauseHandshake() { pauseHandshake = true; },
		releaseHandshakes() { pauseHandshake = false; for (const helper of helpers) helper.handshake(); },
		dispose() {
			if (disposed) return;
			disposed = true;
			releaseLoad.resolve();
			// Mark mocks dead before restoring spawn: the next test must not reuse
			// this fixture's module-global helper, or start a real process.
			for (const helper of helpers) {
				helper.owner.alive = false;
				helper.proc.exitCode = 0;
				helper.abortHangs();
			}
			mock.restoreAll(); syncBuiltinESMExports();
		},
	};
}

it("a queued production demo acquires a fresh helper after the active helper cannot retire", { timeout: 5_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	try {
		assert.equal((await realHeadless.runDemo("<p>warm</p>", { settleMs: 0 })).ok, true);
		const original = fixture.helpers[0]!;
		original.owner.failRetirement = true;
		original.owner.holdNextLoad = true;
		const first = realHeadless.runDemo("<p>failed retirement</p>", { settleMs: 0 });
		await fixture.heldLoad.promise;
		const second = realHeadless.runDemo("<p>queued success</p>", { settleMs: 0 });
		// Drain cached-import microtasks while the first document is explicitly
		// held; the queue must not acquire/capture another Browser yet.
		await setImmediate();
		const acquiredWhileHeld = fixture.connections();
		fixture.releaseLoad.resolve();
		const [failed, next] = await Promise.allSettled([first, second]);
		assert.equal(failed.status, "rejected");
		assert.match((failed as PromiseRejectedResult).reason.message, /Could not retire/);
		assert.equal(next.status, "fulfilled", "queued work must not retain the killed Browser");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.equal(acquiredWhileHeld, 2, "only warm and active jobs have connected");
		assert.deepEqual(fixture.killed, [1]);
		assert.equal(original.owner.alive, false, "the unretired original helper is discarded");
		assert.equal(original.guarded(), true);
		assert.equal(original.page.listenerCount("request"), 1, "guard remains until the failed helper is killed");
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.helpers[1]!.guarded(), false);
		assert.equal(fixture.helpers[1]!.page.listenerCount("request"), 0);
	} finally { fixture.dispose(); }
});

it("concurrent cold-start production demos cannot replace the helper whose retirement fails", { timeout: 5_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	fixture.pauseHandshake();
	try {
		const first = realHeadless.runDemo("<p>cold failing helper</p>", { settleMs: 0 });
		await fixture.spawned.promise;
		const original = fixture.helpers[0]!;
		original.owner.failRetirement = true;
		const second = realHeadless.runDemo("<p>cold queued success</p>", { settleMs: 0 });
		await setImmediate();
		const spawnedBeforeHandshake = fixture.helpers.length;
		fixture.releaseHandshakes();
		const [failed, next] = await Promise.allSettled([first, second]);
		assert.equal(failed.status, "rejected");
		assert.match((failed as PromiseRejectedResult).reason.message, /Could not retire/);
		assert.equal(next.status, "fulfilled", "the queued job must start on its own fresh helper");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.equal(spawnedBeforeHandshake, 1, "cold acquisition itself must be inside the page queue");
		assert.deepEqual(fixture.killed, [1], "never kill a later helper instead of the failed document's owner");
		assert.equal(original.owner.alive, false, "no original unretired helper remains alive");
		assert.equal(original.guarded(), true);
		assert.equal(original.page.listenerCount("request"), 1);
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.helpers[1]!.guarded(), false);
		assert.equal(fixture.helpers[1]!.page.listenerCount("request"), 0);
	} finally { fixture.dispose(); }
});

it("concurrent cold-start demos share one helper and disconnect after each use", { timeout: 10_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	fixture.pauseHandshake();
	try {
		const first = realHeadless.runDemo("<p>cold one</p>", { settleMs: 0 });
		await fixture.spawned.promise;
		const second = realHeadless.runDemo("<p>cold two</p>", { settleMs: 0 });
		await setImmediate();
		assert.equal(fixture.helpers.length, 1, "two cold demos must not spawn two helpers");
		fixture.releaseHandshakes();
		const [one, two] = await Promise.all([first, second]);
		assert.equal(one.ok, true);
		assert.equal(two.ok, true);
		assert.equal(fixture.helpers.length, 1, "second demo reuses the shared helper");
		assert.equal(fixture.connections(), 2);
		assert.equal(fixture.disconnects(), 2, "each run must disconnect its puppeteer client");
		assert.deepEqual(fixture.killed, []);
	} finally { fixture.dispose(); }
});

it("kills a hung helper after its deadline, disconnects, and lets the next queued demo finish", { timeout: 10_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	try {
		assert.equal((await realHeadless.runDemo("<p>warm</p>", { settleMs: 0 })).ok, true);
		const original = fixture.helpers[0]!;
		original.owner.hangNextLoad = true;
		const first = realHeadless.runDemo("<script>while(true){}</script>", { settleMs: 0, timeoutMs: 80 });
		await fixture.heldLoad.promise;
		const second = realHeadless.runDemo("<p>queued after hang</p>", { settleMs: 0, timeoutMs: 5_000 });
		const [hung, next] = await Promise.allSettled([first, second]);
		assert.equal(hung.status, "rejected");
		assert.match((hung as PromiseRejectedResult).reason.message, /timed out/i);
		assert.equal(next.status, "fulfilled", "queued demo must proceed on a fresh helper");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.deepEqual(fixture.killed, [1], "hung helper must be killed at the deadline");
		assert.equal(original.owner.alive, false);
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.disconnects(), fixture.connections(), "every puppeteer connection must disconnect");
	} finally { fixture.dispose(); }
});

it("kills a helper whose probe hangs past the deadline and recovers for the next demo", { timeout: 10_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	try {
		assert.equal((await realHeadless.runDemo("<p>warm</p>", { settleMs: 0 })).ok, true);
		const original = fixture.helpers[0]!;
		original.owner.hangNextEvaluate = true;
		const first = realHeadless.runDemo("<p>hung probe</p>", { settleMs: 0, probe: "1 + 1", timeoutMs: 80 });
		const second = realHeadless.runDemo("<p>after probe hang</p>", { settleMs: 0, timeoutMs: 5_000 });
		const [hung, next] = await Promise.allSettled([first, second]);
		assert.equal(hung.status, "rejected");
		assert.match((hung as PromiseRejectedResult).reason.message, /timed out/i);
		assert.equal(next.status, "fulfilled", "queued demo must recover after a hung probe");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.deepEqual(fixture.killed, [1]);
		assert.equal(original.owner.alive, false);
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.disconnects(), fixture.connections());
	} finally { fixture.dispose(); }
});

it("discards a helper whose CDP connect fails so the next demo starts a fresh one", { timeout: 10_000 }, async (t) => {
	const fixture = lifecycleFixture();
	t.after(() => fixture.dispose());
	mock.method(puppeteer, "launch", async () => {
		throw new Error("chrome fallback disabled in test");
	});
	try {
		fixture.failNextConnect();
		await assert.rejects(
			realHeadless.runDemo("<p>connect failure</p>", { settleMs: 0 }),
			/chrome fallback disabled in test/,
		);
		assert.deepEqual(fixture.killed, [1], "unreachable helper must be killed instead of staying cached");
		assert.equal(fixture.helpers[0]!.owner.alive, false);
		const recovered = await realHeadless.runDemo("<p>fresh helper</p>", { settleMs: 0 });
		assert.equal(recovered.ok, true);
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.disconnects(), 1);
	} finally { fixture.dispose(); }
});
