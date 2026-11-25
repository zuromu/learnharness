/** Server exit recovery and startup failure dialogs against the real main.cjs shell. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

type MessageBoxCall = { parent?: unknown; options: { type?: string; buttons?: string[]; defaultId?: number; cancelId?: number; title?: string; message?: string; detail?: string } };
type ErrorBoxCall = { title: string; content: string };

interface BootOptions {
	httpMode?: "ready" | "refuse" | "defer";
	messageBoxResponse?: number;
	subscriptionsReadyError?: Error;
	spawnError?: Error;
}

function bootPackaged(options: BootOptions = {}) {
	const {
		httpMode = "ready",
		messageBoxResponse = 0,
		subscriptionsReadyError,
		spawnError,
	} = options;

	const windows: FakeWindow[] = [];
	const messageBoxes: MessageBoxCall[] = [];
	const errorBoxes: ErrorBoxCall[] = [];
	const exits: number[] = [];
	const logs: string[] = [];
	const kills: string[] = [];
	let relaunches = 0;
	let quits = 0;
	let httpAttempts = 0;
	let resolveHttp!: () => void;
	const deferredHttp = new Promise<void>((resolve) => { resolveHttp = resolve; });

	const children: FakeChild[] = [];
	class FakeChild extends EventEmitter {
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		connected = true;
		exitCode: number | null = null;
		signalCode: string | null = null;
		kill(signal: string) {
			kills.push(signal);
			return true;
		}
		crash(code: number | null, signal: string | null) {
			this.connected = false;
			this.exitCode = code;
			this.signalCode = signal;
			this.emit("exit", code, signal);
		}
	}

	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:43210/" };
		setWindowOpenHandler() {}
		send() {}
		getZoomFactor() { return 1; }
		isLoadingMainFrame() { return false; }
	}

	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		loaded: string[] = [];
		destroyed = false;
		constructor() { super(); windows.push(this); }
		loadURL(url: string) { this.loaded.push(url); }
		show() {}
		isDestroyed() { return this.destroyed; }
		isMinimized() { return false; }
		restore() {}
		focus() {}
		static getAllWindows() { return windows; }
		static fromWebContents(sender: unknown) { return windows.find((win) => win.webContents === sender); }
	}

	const app = Object.assign(new EventEmitter(), {
		isPackaged: true,
		name: "LearnHarness",
		setName() {},
		getPath: () => "/fixture/LearnHarness",
		setPath() {},
		requestSingleInstanceLock: () => true,
		whenReady: async () => {},
		isReady: () => true,
		relaunch() { relaunches++; },
		quit() { quits++; },
		exit(code: number) { exits.push(code); },
	});

	const dialog = {
		async showMessageBox(first: unknown, second?: unknown) {
			if (second !== undefined) {
				messageBoxes.push({ parent: first, options: second as MessageBoxCall["options"] });
			} else {
				messageBoxes.push({ options: first as MessageBoxCall["options"] });
			}
			return { response: messageBoxResponse, checkboxChecked: false };
		},
		showErrorBox(title: string, content: string) {
			errorBoxes.push({ title, content });
		},
	};

	const electron = {
		app,
		BrowserWindow: FakeWindow,
		dialog,
		Menu: { buildFromTemplate: (v: unknown) => v, setApplicationMenu() {} },
		ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: {
			defaultSession: {
				setPermissionRequestHandler() {},
				setPermissionCheckHandler() {},
				webRequest: { onBeforeSendHeaders() {} },
			},
		},
		shell: { openExternal: async () => {} },
	};

	const net = {
		createServer: () => Object.assign(new EventEmitter(), {
			listen(_port: number, _host: string, cb: () => void) { cb(); },
			address: () => ({ port: 43210 }),
			close(cb: () => void) { cb(); },
		}),
	};

	const http = {
		get(_url: string, cb: (res: { statusCode: number; resume(): void }) => void) {
			httpAttempts++;
			const req = Object.assign(new EventEmitter(), {
				destroyed: false,
				destroy() { this.destroyed = true; },
			});
			if (httpMode === "ready") {
				queueMicrotask(() => {
					if (!req.destroyed) cb({ statusCode: 200, resume() {} });
				});
			} else if (httpMode === "refuse") {
				queueMicrotask(() => {
					if (!req.destroyed) req.emit("error", new Error("ECONNREFUSED"));
				});
			} else if (httpMode === "defer") {
				void deferredHttp.then(() => {
					if (!req.destroyed) cb({ statusCode: 200, resume() {} });
				});
			}
			return req;
		},
	};

	let nextTimerId = 1;
	const activeTimers = new Set<number>();
	const fakeSetTimeout = (fn: () => void, ms: number) => {
		const id = nextTimerId++;
		activeTimers.add(id);
		if (ms <= 200) {
			queueMicrotask(() => {
				if (activeTimers.delete(id)) fn();
			});
		}
		return { id, unref() {} };
	};
	const fakeClearTimeout = (handle: { id?: number } | null | undefined) => {
		if (handle?.id !== undefined) activeTimers.delete(handle.id);
	};

	const subscriptionsReady = subscriptionsReadyError
		? Promise.reject(subscriptionsReadyError)
		: Promise.resolve();
	// Attach a no-op handler only if the caller did not observe it yet? No, main() awaits it synchronously after whenReady.

	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "electron-updater") throw new Error("not needed in fixture");
			if (id === "node:net") return net;
			if (id === "node:http") return http;
			if (id === "node:fs") return {
				existsSync: () => false,
				readFileSync: () => "{}",
				mkdirSync() {},
				appendFileSync() {},
			};
			if (id === "node:child_process") return {
				spawn() {
					const child = new FakeChild();
					children.push(child);
					if (spawnError) {
						queueMicrotask(() => child.emit("error", spawnError));
					}
					return child;
				},
			};
			if (id === "./appearance-chrome.cjs") return {
				...mainRequire(id),
				readAppearance: () => ({ mode: "dark", background: "#141414" }),
			};
			if (id === "./chatgpt.cjs") return {
				createChatGPT: () => ({ close() {}, pause() {}, resume() {} }),
				fileStore: () => ({}),
			};
			if (id === "./chatgpt-ipc.cjs") return {
				attachChatGPTChild: () => ({ send() {}, dispose() {} }),
				trustedSender: () => true,
				chatGPTControl: () => ({}),
			};
			if (id === "./subscriptions.cjs") return {
				createSubscriptions: () => ({ ready: subscriptionsReady, close() {}, pause() {}, resume() {} }),
				loadSubscriptionSDK: () => ({}),
			};
			if (id === "./subscription-ipc.cjs") return {
				attachSubscriptionChild: () => ({ send() {}, dispose() {} }),
				subscriptionControl: () => ({}),
			};
			return mainRequire(id);
		},
		process: Object.assign(new EventEmitter(), {
			platform: "darwin",
			argv: [],
			env: {},
			execPath: "/fixture/LearnHarness",
			resourcesPath: "/fixture/resources",
		}),
		__dirname: path.dirname(mainFile),
		URL,
		AbortController,
		setTimeout: fakeSetTimeout,
		clearTimeout: fakeClearTimeout,
		setInterval() { return { unref() {} }; },
		console: { log: (line: string) => logs.push(line) },
	});

	runInContext(mainSource, context, { filename: mainFile });

	async function settle(turns = 10) {
		for (let i = 0; i < turns; i++) await turn();
	}

	return {
		app,
		windows,
		children,
		messageBoxes,
		errorBoxes,
		exits,
		logs,
		kills,
		get relaunches() { return relaunches; },
		get quits() { return quits; },
		get httpAttempts() { return httpAttempts; },
		resolveHttp,
		settle,
	};
}

describe("desktop server exit recovery and startup error handling", () => {
	it("shows a Restart dialog and relaunches when the server is killed unexpectedly", async () => {
		const f = bootPackaged({ httpMode: "ready", messageBoxResponse: 0 });
		await f.settle();
		assert.equal(f.windows.length, 1);
		assert.equal(f.children.length, 1);

		f.children[0]!.crash(null, "SIGKILL");
		await f.settle();

		assert.equal(f.messageBoxes.length, 1);
		const call = f.messageBoxes[0]!;
		assert.equal(call.parent, f.windows[0]);
		assert.equal(call.options.type, "error");
		assert.ok(call.options.buttons?.includes("Restart"), "dialog must offer Restart");
		assert.equal(call.options.buttons?.[call.options.defaultId ?? 0], "Restart");
		assert.match(call.options.detail ?? "", /SIGKILL/);
		assert.equal(f.relaunches, 1);
		assert.deepEqual(f.exits, [0]);
		assert.equal(f.quits, 0);
	});

	it("quits cleanly without relaunching when the user chooses Quit on unexpected exit", async () => {
		const f = bootPackaged({ httpMode: "ready", messageBoxResponse: 1 });
		await f.settle();
		assert.equal(f.windows.length, 1);

		f.children[0]!.crash(1, null);
		await f.settle();

		assert.equal(f.messageBoxes.length, 1);
		assert.match(f.messageBoxes[0]!.options.detail ?? "", /1/);
		assert.equal(f.relaunches, 0);
		assert.equal(f.quits, 1);
		assert.deepEqual(f.exits, []);
	});

	it("shows the Restart dialog without a parent window when all windows are closed", async () => {
		const f = bootPackaged({ httpMode: "ready", messageBoxResponse: 0 });
		await f.settle();
		f.windows.length = 0;

		f.children[0]!.crash(null, "SIGKILL");
		await f.settle();

		assert.equal(f.messageBoxes.length, 1);
		assert.equal("parent" in f.messageBoxes[0]!, false);
		assert.equal(f.relaunches, 1);
		assert.deepEqual(f.exits, [0]);
	});

	it("does not show a crash dialog when the server exits during normal quit", async () => {
		const f = bootPackaged({ httpMode: "ready" });
		await f.settle();
		assert.equal(f.children.length, 1);

		f.app.emit("before-quit");
		assert.deepEqual(f.kills, ["SIGTERM"]);
		f.children[0]!.crash(0, "SIGTERM");
		await f.settle();

		assert.deepEqual(f.messageBoxes, []);
		assert.deepEqual(f.errorBoxes, []);
		assert.equal(f.relaunches, 0);
	});

	it("shows a startup error dialog and exits when the server exits before becoming ready", async () => {
		const f = bootPackaged({ httpMode: "defer" });
		await f.settle();
		assert.equal(f.children.length, 1);
		assert.equal(f.windows.length, 0);

		f.children[0]!.crash(1, null);
		await f.settle();

		assert.equal(f.windows.length, 0);
		assert.equal(f.errorBoxes.length, 1);
		assert.equal(f.messageBoxes.length, 0, "startup crash must not show a duplicate restart dialog");
		assert.match(f.errorBoxes[0]!.content, /1/);
		assert.deepEqual(f.exits, [1]);
		assert.ok(f.logs.some((line) => line.includes("startup failed")));
	});

	it("shows a startup error dialog, kills the hung child, and exits if the server never answers", async () => {
		const f = bootPackaged({ httpMode: "refuse" });
		await f.settle(20);

		assert.equal(f.windows.length, 0);
		assert.equal(f.errorBoxes.length, 1);
		assert.match(f.errorBoxes[0]!.content, /server never answered/);
		assert.deepEqual(f.kills, ["SIGTERM"]);
		assert.deepEqual(f.exits, [1]);

		// The hung child exiting after SIGTERM must not pop a second dialog.
		f.children[0]!.crash(null, "SIGTERM");
		await f.settle();
		assert.equal(f.messageBoxes.length, 0);
	});

	it("shows a startup error dialog and exits if startup fails before spawning the server", async () => {
		const f = bootPackaged({ subscriptionsReadyError: new Error("corrupt subscription store") });
		await f.settle();

		assert.equal(f.windows.length, 0);
		assert.equal(f.errorBoxes.length, 1);
		assert.match(f.errorBoxes[0]!.content, /corrupt subscription store/);
		assert.deepEqual(f.exits, [1]);
	});

	it("shows a startup error dialog and exits if the server fails to spawn", async () => {
		const f = bootPackaged({ httpMode: "defer", spawnError: new Error("spawn ENOENT") });
		await f.settle();

		assert.equal(f.windows.length, 0);
		assert.equal(f.errorBoxes.length, 1);
		assert.equal(f.messageBoxes.length, 0);
		assert.match(f.errorBoxes[0]!.content, /spawn ENOENT/);
		assert.deepEqual(f.exits, [1]);
	});

	it("suppresses startup error dialogs when the user quits before startup completes", async () => {
		const f = bootPackaged({ httpMode: "defer" });
		await f.settle();
		assert.equal(f.children.length, 1);

		f.app.emit("before-quit");
		f.children[0]!.crash(null, "SIGTERM");
		await f.settle();

		assert.deepEqual(f.errorBoxes, []);
		assert.deepEqual(f.messageBoxes, []);
		assert.deepEqual(f.exits, []);
	});
});
