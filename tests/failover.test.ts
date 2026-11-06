import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import { freeOnlySpecs, isCapacityError, parseFreeChain, resetFailoverCooldowns, withFailover } from "../src/agent/failover.ts";
import type { PiEngine } from "../src/agent/models.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (id: string, extra: Partial<AssistantMessage> = {}) =>
	({ role: "assistant", content: [], api: "x", provider: "p", model: id, usage, stopReason: "stop", timestamp: 1, ...extra }) as AssistantMessage;

function fake(id: string, reply: "ok" | "rate" | "other-error" | "error-after-content" | "hang", calls: string[]): PiEngine {
	return {
		model: { provider: "p", id, api: "x" } as unknown as Model<Api>,
		streamFn: () => {
			calls.push(id);
			const s = createAssistantMessageEventStream();
			queueMicrotask(() => {
				s.push({ type: "start", partial: message(id) });
				if (reply === "hang") return;
				if (reply === "ok") s.push({ type: "done", reason: "stop", message: message(id) });
				else if (reply === "rate") s.push({ type: "error", reason: "error", error: message(id, { stopReason: "error", errorMessage: "Mistral API error (429): Rate limit exceeded" }) });
				else if (reply === "other-error") s.push({ type: "error", reason: "error", error: message(id, { stopReason: "error", errorMessage: "invalid api key" }) });
				else {
					s.push({ type: "text_start", contentIndex: 0, partial: message(id) });
					s.push({ type: "error", reason: "error", error: message(id, { stopReason: "error", errorMessage: "429 midway" }) });
				}
			});
			return s;
		},
	};
}

async function run(engine: PiEngine) {
	const types: string[] = [];
	const stream = engine.streamFn(engine.model, { messages: [] } as never);
	for await (const e of stream) types.push(e.type);
	return { types, final: await stream.result() };
}

describe("failover chain", () => {
	beforeEach(() => resetFailoverCooldowns());

	it("recognises capacity errors only", () => {
		assert.equal(isCapacityError(message("a", { errorMessage: "429: Rate limit reached" })), true);
		assert.equal(isCapacityError(message("a", { errorMessage: "413 Request too large" })), true);
		assert.equal(isCapacityError(message("a", { errorMessage: "invalid api key" })), false);
		assert.equal(isCapacityError(undefined), false);
	});

	it("uses the first engine when it works", async () => {
		const calls: string[] = [];
		const { final } = await run(withFailover([fake("a", "ok", calls), fake("b", "ok", calls)]));
		assert.deepEqual(calls, ["a"]);
		assert.equal(final.model, "a");
	});

	it("falls over to the next engine on a rate limit and reports it", async () => {
		const calls: string[] = [];
		const seen: string[] = [];
		const { types, final } = await run(withFailover([fake("a", "rate", calls), fake("b", "ok", calls)], { onFailover: (from, to) => seen.push(`${from}->${to}`) }));
		assert.deepEqual(calls, ["a", "b"]);
		assert.deepEqual(seen, ["p:a->p:b"]);
		assert.equal(final.model, "b");
		assert.equal(types.includes("error"), false);
	});

	it("skips an engine in cooldown on the next request, then retries it after", async () => {
		const calls: string[] = [];
		let t = 0;
		const chain = withFailover([fake("a", "rate", calls), fake("b", "ok", calls)], { cooldownMs: 1000, now: () => t });
		await run(chain);
		calls.length = 0;
		await run(chain);
		assert.deepEqual(calls, ["b"]);
		t = 2000;
		calls.length = 0;
		await run(chain);
		assert.deepEqual(calls, ["a", "b"]);
	});

	it("fails over on any pre-content error, but not after content started", async () => {
		const calls: string[] = [];
		const other = await run(withFailover([fake("a", "other-error", calls), fake("b", "ok", calls)]));
		assert.deepEqual(calls, ["a", "b"]);
		assert.equal(other.final.model, "b");
		calls.length = 0;
		const mid = await run(withFailover([fake("c", "error-after-content", calls), fake("d", "ok", calls)]));
		assert.deepEqual(calls, ["c"]);
		assert.equal(mid.final.errorMessage, "429 midway");
	});

	it("surfaces the last engine's error when every engine fails", async () => {
		const calls: string[] = [];
		const { final } = await run(withFailover([fake("a", "rate", calls), fake("b", "rate", calls)]));
		assert.deepEqual(calls, ["a", "b"]);
		assert.equal(final.stopReason, "error");
		assert.equal(final.model, "b");
	});

	it("parses the free chain list and ignores bad entries", () => {
		assert.deepEqual(parseFreeChain("mistral:mistral-small-2603, openrouter:meta/llama-3:free ,bad,:x,y:"), [
			{ provider: "mistral", id: "mistral-small-2603" },
			{ provider: "openrouter", id: "meta/llama-3:free" },
		]);
		assert.deepEqual(parseFreeChain(undefined), []);
	});

	it("fails over when an engine sends no content in time", async () => {
		const calls: string[] = [];
		const seen: string[] = [];
		const { final } = await run(withFailover([fake("a", "hang", calls), fake("b", "ok", calls)], { firstEventTimeoutMs: 30, onFailover: (_f, _t, why) => seen.push(why) }));
		assert.deepEqual(calls, ["a", "b"]);
		assert.equal(final.model, "b");
		assert.match(seen[0] ?? "", /no response within 30 ms/);
	});

	it("free-only list keeps only providers with a key and never adds a paid model", () => {
		const keys = new Set(["openrouter"]);
		assert.deepEqual(freeOnlySpecs("mistral:a,openrouter:b:free,nvidia:c", (p) => keys.has(p)), [{ provider: "openrouter", id: "b:free" }]);
		assert.deepEqual(freeOnlySpecs("mistral:a", () => false), []);
		assert.deepEqual(freeOnlySpecs(undefined, () => true), []);
	});

	it("a single-engine chain surfaces its error instead of falling back", async () => {
		const calls: string[] = [];
		const { final } = await run(withFailover([fake("only", "rate", calls)]));
		assert.deepEqual(calls, ["only"]);
		assert.equal(final.stopReason, "error");
	});
});
