import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { PiEngine } from "./models.ts";

/**
 * Failover chain (opt-in, used by the auto model router): try engines in
 * order and move to the next one when an attempt fails (rate limit, too
 * large, model unavailable, bad key) or sends nothing in time, BEFORE it
 * produces any content. A user abort and any failure after content began are
 * forwarded unchanged; the last engine's result is always forwarded.
 * An engine that just failed this way is skipped for a cooldown, except the
 * last one, which is always tried.
 */

const CAPACITY_ERROR = /\b(429|413|503|529)\b|rate.?limit|too large|overloaded|capacity|quota/i;

export function isCapacityError(message: AssistantMessage | undefined): boolean {
	return !!message?.errorMessage && CAPACITY_ERROR.test(message.errorMessage);
}

const cooldownUntil = new Map<string, number>();

export function resetFailoverCooldowns(): void {
	cooldownUntil.clear();
}

function engineKey(engine: PiEngine): string {
	return `${engine.model.provider}:${engine.model.id}`;
}

export function withFailover(
	engines: readonly PiEngine[],
	options: { cooldownMs?: number; firstEventTimeoutMs?: number; now?: () => number; onFailover?: (from: string, to: string, reason: string) => void } = {},
): PiEngine {
	const primary = engines[0];
	if (!primary) throw new Error("withFailover needs at least one engine");
	const cooldownMs = options.cooldownMs ?? 60_000;
	const now = options.now ?? Date.now;
	// Free endpoints sometimes queue a request for minutes without erroring, so a
	// non-last engine that sends no content within this time counts as failed.
	const firstEventTimeoutMs = options.firstEventTimeoutMs ?? 25_000;
	return {
		model: primary.model,
		level: primary.level,
		streamFn: (_requestModel, context, streamOptions) => {
			const out = createAssistantMessageEventStream();
			void (async () => {
				for (let i = 0; i < engines.length; i++) {
					const engine = engines[i];
					if (!engine) continue;
					const last = i === engines.length - 1;
					const key = engineKey(engine);
					if (!last && (cooldownUntil.get(key) ?? 0) > now()) continue;
					const controller = new AbortController();
					const signal = streamOptions?.signal ? AbortSignal.any([streamOptions.signal, controller.signal]) : controller.signal;
					const attempt: AssistantMessageEventStream = engine.streamFn(engine.model, context, { ...streamOptions, signal });
					const iterator = attempt[Symbol.asyncIterator]();
					const buffered: AssistantMessageEvent[] = [];
					let forwarding = false;
					let failedOver = false;
					const failOver = (reason: string) => {
						cooldownUntil.set(key, now() + cooldownMs);
						options.onFailover?.(key, engineKey(engines[i + 1] ?? engine), reason);
						controller.abort();
						failedOver = true;
					};
					for (;;) {
						let next: IteratorResult<AssistantMessageEvent>;
						if (forwarding || last) next = await iterator.next();
						else {
							let timer: ReturnType<typeof setTimeout> | undefined;
							const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), firstEventTimeoutMs); });
							const raced = await Promise.race([iterator.next(), timeout]);
							clearTimeout(timer);
							if (raced === "timeout") { failOver(`no response within ${firstEventTimeoutMs} ms`); break; }
							next = raced;
						}
						if (next.done) break;
						const event = next.value;
						if (forwarding) { out.push(event); continue; }
						if (event.type === "start") { buffered.push(event); continue; }
						if (event.type === "error" && !last && event.reason !== "aborted") { failOver(event.error.errorMessage ?? ""); break; }
						forwarding = true;
						for (const held of buffered) out.push(held);
						out.push(event);
					}
					if (failedOver) continue;
					if (!forwarding) for (const held of buffered) out.push(held);
					out.end();
					return;
				}
				out.end();
			})().catch((err) => {
				out.push({
					type: "error",
					reason: "error",
					error: { role: "assistant", content: [], api: primary.model.api, provider: primary.model.provider, model: primary.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(err), timestamp: Date.now() } as AssistantMessage,
				});
				out.end();
			});
			return out;
		},
	};
}

/** Parse LH_FREE_CHAIN: comma-separated `provider:model-id` entries, in the
 *  order they should be tried. Malformed entries are ignored. */
export function parseFreeChain(value: string | undefined): { provider: string; id: string }[] {
	const out: { provider: string; id: string }[] = [];
	for (const raw of (value ?? "").split(",")) {
		const entry = raw.trim();
		const at = entry.indexOf(":");
		if (at <= 0 || at === entry.length - 1) continue;
		out.push({ provider: entry.slice(0, at), id: entry.slice(at + 1) });
	}
	return out;
}
