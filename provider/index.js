import z from "@deepseek-ai/schemastery";
import { AssistantOutputFold, assertUsableCwd, settleRunResult, subprocessRunHandle } from "@deepseek-ai/dsh-subagent";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { brandString } from "@deepseek-ai/dsh-brand";
import { appendFile, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
//#region lib/types/run.js
/**
* Fresh-process ACP subagent client. Drives one child session and owns cancellation and
* quiescent disposal.
*
* @module @deepseek-ai/dsh-subagent-acp/run
*/
/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
const DEFAULT_DISPOSE_EOF_GRACE_MS = 6e3;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
const ACP_TOOL_KINDS = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other"
]);
/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(facts) {
	const fields = [
		"provider: ACP",
		`stage: ${facts.stage}`,
		`category: ${facts.category}`
	];
	if (facts.stopReason !== void 0) fields.push(`stop reason: ${facts.stopReason}`);
	if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== void 0) fields.push(`exit code: ${facts.outcome.exitCode}`);
	/* v8 ignore next -- Windows does not report POSIX child signals in SubprocessOutcome. */
	if (facts.outcome?.signal !== null && facts.outcome?.signal !== void 0) fields.push(`signal: ${facts.outcome.signal}`);
	return `Subagent failure (${fields.join("; ")})`;
}
/** Fixed permission fact; ACP tool titles and option text never enter it. */
function permissionDiagnostic(permission) {
	return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`;
}
/** Put the operation failure first, followed by the latest permission decision. */
function diagnosticText(facts, permission) {
	const failure = failureDiagnostic(facts);
	return permission === void 0 ? failure : `${failure}\n${permissionDiagnostic(permission)}`;
}
var AcpRunFailure = class extends Error {
	constructor(facts, cause) {
		super(`subagent-acp: ${failureDiagnostic(facts)}`, { cause });
		this.name = "AcpRunFailure";
	}
};
/**
* Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
* @param cause - original Host failure retained on the Error cause chain.
* @returns an Error whose message contains only the fixed ACP failure line.
*/
function acpConfigurationFailure(cause) {
	return new AcpRunFailure({
		stage: "initialize",
		category: "configuration"
	}, cause);
}
/** Keep only the closed ACP tool-kind vocabulary; future values use a fixed fallback. */
function permissionRequestKind(kind) {
	const candidate = kind ?? "unknown";
	return ACP_TOOL_KINDS.has(candidate) ? candidate : "unknown";
}
/** Bounded managed-range exit wait: observes the handle's range until it is empty or `ms` elapses. */
async function rangeExitsWithin(child, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, ms);
	try {
		return await child.waitForExit(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
/**
* Cooperative teardown ladder for an out-of-process agent, over the seam's
* public verbs; resolves only at whole-range quiescence: stdin EOF (the child's
* window to flush persistence and reap its own descendants), then the
* terminate() escalation (SIGTERM → spec grace → SIGKILL) and its
* whole-range exit proof.
* @param child - the spawned ACP child's handle.
* @param eofGraceMs - tier-1 window after stdin EOF.
*/
async function disposeAcpChild(child, eofGraceMs) {
	const failures = [];
	child.stdin?.end();
	let exited = false;
	try {
		exited = await rangeExitsWithin(child, eofGraceMs);
	} catch (error) {
		failures.push(toError(error));
	}
	if (exited) return;
	child.terminate();
	try {
		await child.waitForExit();
	} catch (error) {
		failures.push(toError(error));
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "ACP subprocess teardown failed");
}
/**
* Map an ACP {@link StopReason} to a harness {@link SubagentStopReason}.
* @param reason - the terminal reason from the child's `session/prompt` response.
* @returns the harness equivalent; `max_turn_requests` and any unknown future
* variant map to `error`, so an unclean stop is never reported as `completed`.
*/
function acpStopReason(reason) {
	switch (reason) {
		case "end_turn": return "completed";
		case "max_tokens": return "max-tokens";
		case "refusal": return "refusal";
		case "cancelled": return "aborted";
		case "max_turn_requests": return "error";
		default: return "error";
	}
}
/**
* Collect the text of an ACP content block (non-text blocks contribute nothing).
* @param content - the content block off a streamed `agent_message_chunk`.
* @returns the block's text, or `''` for a non-text block.
*/
function acpContentText(content) {
	return content.type === "text" ? content.text : "";
}
/**
* Translate the harness prompt blocks into ACP prompt blocks (text only).
* @param prompt - the harness prompt; non-text blocks are dropped.
* @returns the ACP text blocks, in order.
*/
function toAcpPrompt(prompt) {
	const blocks = [];
	for (const block of prompt) if (block.type === "text") blocks.push({
		type: "text",
		text: block.text
	});
	return blocks;
}
/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value) {
	/* v8 ignore next */
	return value instanceof Error ? value : new Error(String(value));
}
/** Report an original Host failure without letting the observation sink replace it. */
function reportFailure(spec, error) {
	try {
		spec.onError?.(toError(error), "error");
	} catch {}
}
/** Classify an unpublished failure from the active protocol operation and observed process facts. */
function startupFailure(error, stage, outcome) {
	return new AcpRunFailure(
		/* v8 ignore next -- Windows anonymous pipes cannot expose a live-child protocol close during startup. */
		outcome === void 0 ? {
			stage,
			category: "transport"
		} : {
			stage,
			category: "process-exit",
			outcome
		},
		error
	);
}
/** Map one remote terminal reason to the optional safe failure line it needs. */
function terminalFailure(reason, permission) {
	switch (reason) {
		case "end_turn": return;
		case "max_turn_requests": return diagnosticText({
			stage: "prompt",
			category: "remote-limit",
			stopReason: "max_turn_requests"
		}, permission);
		case "max_tokens":
		case "refusal":
		case "cancelled": return permission === void 0 ? void 0 : permissionDiagnostic(permission);
		default: return diagnosticText({
			stage: "prompt",
			category: "unknown",
			stopReason: "unknown"
		}, permission);
	}
}
/**
* Start and publish one ACP child after initialization and session creation.
* Child failures resolve through the run result. Startup rejects with fixed
* safe facts after provider-owned cleanup; successful cleanup proves managed
* range quiescence. Cleanup failure preserves startup plus teardown facts for an ordinary
* failure, or teardown alone after cancellation, without claiming quiescence.
* Disposal cancels, terminates, and settles the child's managed range.
* @param request - the start request; its signal is the cancellation channel.
* @param spec - the resolved spawn spec: command/args/cwd, env, permission
* policy, dispose graces, and the optional error sink.
* @returns the ready run handle for the child subprocess.
*/
async function startAcpRun(request, spec) {
	if (request.signal.aborted) throw new Error("subagent request was aborted before the ACP child started");
	const id = brandString(randomUUID());
	let child;
	try {
		child = spec.spawn({
			argv: [spec.command, ...spec.args],
			cwd: spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit"
			},
			graceMs: spec.disposeGraceMs,
			env: spec.env
		});
	} catch (error) {
		reportFailure(spec, error);
		throw new AcpRunFailure({
			stage: "process",
			category: "process-start"
		}, error);
	}
	/* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
	if (child.stdin === void 0 || child.stdout === void 0) throw new Error("subagent-acp: subprocess implementation dropped a piped protocol stream");
	/* v8 ignore stop */
	let processOutcome;
	let processFailure;
	const processDone = child.done.then((outcome) => {
		processOutcome = outcome;
		return outcome;
	}, (error) => {
		processFailure = toError(error);
		throw processFailure;
	});
	const processRejected = processDone.then(
		/* v8 ignore next -- the success arm's never-settling executor is intentionally empty. */
		() => new Promise(() => {}),
		(err) => Promise.reject(toError(err))
	);
	processRejected.catch(() => {});
	const observeProcessOutcome = async (signal) => {
		if (processOutcome !== void 0) return processOutcome;
		const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs));
		const bound = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		const aborted = Promise.withResolvers();
		/* v8 ignore next -- Windows cannot expose the live-child protocol close needed to await this abort. */
		const onObservationAbort = () => {
			aborted.resolve(void 0);
		};
		bound.addEventListener("abort", onObservationAbort, { once: true });
		/* v8 ignore next -- closes the event-loop race between listener registration and the preceding derived-signal check. */
		if (bound.aborted) onObservationAbort();
		try {
			return await Promise.race([processDone, aborted.promise]);
		} catch {
			return processOutcome;
		} finally {
			bound.removeEventListener("abort", onObservationAbort);
		}
	};
	let processDisposal;
	const disposeProcess = () => processDisposal ??= disposeAcpChild(child, spec.disposeEofGraceMs);
	const fold = new AssistantOutputFold();
	let replaying = true;
	let lastReplayAt = Date.now();
	/** Wait for the load replay to go quiet, then start folding new answer text. */
	const settleReplay = async () => {
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && Date.now() - lastReplayAt < 200) await new Promise((resolve) => setTimeout(resolve, 50));
		replaying = false;
	};
	const flags = { cancelled: false };
	let latestPermission;
	const agent = client({ name: "deepseek-harness-subagent-acp" }).onNotification(methods.client.session.update, ({ params }) => {
		const update = params.update;
		if (replaying) lastReplayAt = Date.now();
		else if (update.sessionUpdate === "agent_message_chunk") fold.pushText(acpContentText(update.content));
		spec.transcript?.update(update, replaying);
		return Promise.resolve();
	}).onRequest(methods.client.session.requestPermission, ({ params }) => {
		if (spec.permission === "allow") {
			const allow = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
			if (allow !== void 0) {
				latestPermission = {
					policy: "allow",
					request: permissionRequestKind(params.toolCall.kind),
					decision: "allowed"
				};
				return Promise.resolve({ outcome: {
					outcome: "selected",
					optionId: allow.optionId
				} });
			}
		}
		latestPermission = {
			policy: spec.permission,
			request: permissionRequestKind(params.toolCall.kind),
			decision: "denied"
		};
		return Promise.resolve({ outcome: { outcome: "cancelled" } });
	}).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))).agent;
	let sessionId;
	let resumed = false;
	let startupStage = "initialize";
	let signalCancelSettled;
	const cancelSettled = new Promise((resolve) => {
		signalCancelSettled = resolve;
	});
	const requestCancel = () => {
		if (flags.cancelled) return;
		flags.cancelled = true;
		signalCancelSettled();
		/* v8 ignore next */
		if (sessionId !== void 0) agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
	};
	const onAbort = () => {
		requestCancel();
	};
	request.signal.addEventListener("abort", onAbort, { once: true });
	const collectOutput = () => fold.collect() ?? [];
	try {
		await Promise.race([
			(async () => {
				await agent.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {}
				});
				startupStage = "new-session";
				const session = await resumeOrCreateSession(agent, spec);
				resumed = session.resumed === true;
				const returnedSessionId = Reflect.get(session, "sessionId");
				if (typeof returnedSessionId !== "string") throw new AcpRunFailure({
					stage: "new-session",
					category: "protocol"
				}, /* @__PURE__ */ new Error("ACP child published without a session id"));
				sessionId = returnedSessionId;
				await spec.transcript?.session(returnedSessionId);
				if (resumed) await settleReplay();
				else replaying = false;
				if (spec.recordPath !== void 0) await writeSessionRecord(spec.recordPath, {
					sessionId: returnedSessionId,
					cwd: spec.cwd,
					model: spec.model,
					updatedAt: Date.now()
				});
				if (spec.model.length > 0) try {
					await agent.request("session/set_model", {
						sessionId: returnedSessionId,
						modelId: spec.model
					});
				} catch (error) {
					spec.onNotice?.(`set_model "${spec.model}" failed: ${toError(error).message}`);
				}
				/* v8 ignore next -- cancelSettled wins the startup race before this post-response guard can settle it. */
				if (flags.cancelled) throw new Error("subagent cancelled before the ACP session started");
			})(),
			processRejected,
			cancelSettled.then(() => {
				throw new Error("subagent cancelled before the ACP session started");
			})
		]);
	} catch (error) {
		request.signal.removeEventListener("abort", onAbort);
		const cancelledBeforeCleanup = flags.cancelled;
		const observedOutcome = !cancelledBeforeCleanup && !(error instanceof AcpRunFailure) ? await observeProcessOutcome() : void 0;
		const startup = cancelledBeforeCleanup ? { kind: "cancelled" } : {
			kind: "failed",
			failure: error instanceof AcpRunFailure ? error : startupFailure(error, startupStage, observedOutcome)
		};
		if (startup.kind === "cancelled") {} else reportFailure(spec, error instanceof AcpRunFailure ? error.cause : processFailure ?? error);
		try {
			await disposeProcess();
		} catch (cleanupError) {
			reportFailure(spec, cleanupError);
			const cleanupFailure = new AcpRunFailure({
				stage: "teardown",
				category: processOutcome === void 0 ? "unknown" : "process-exit",
				...processOutcome === void 0 ? {} : { outcome: processOutcome }
			}, cleanupError);
			if (startup.kind === "cancelled") throw new AggregateError([cleanupFailure], cleanupFailure.message);
			throw new AggregateError([startup.failure, cleanupFailure], `${startup.failure.message}; ${cleanupFailure.message}`);
		}
		if (startup.kind === "cancelled") throw new Error("subagent request was aborted before the ACP child started");
		throw startup.failure;
	}
	/* v8 ignore next */
	if (sessionId === void 0) throw new Error("unreachable: ACP startup fulfilled without a session id");
	const remoteSessionId = sessionId;
	let diagnostic;
	let terminal_usage;
	return subprocessRunHandle({
		id,
		result: settleRunResult({
			attempt: async () => {
				try {
					const promptResult = await Promise.race([agent.request(methods.agent.session.prompt, {
						sessionId: remoteSessionId,
						prompt: toAcpPrompt(request.prompt)
					}), cancelSettled.then(() => {
						throw new Error("subagent cancelled while the ACP prompt was running");
					})]);
					const stopReason = acpStopReason(promptResult.stopReason);
					terminal_usage = promptResult.usage;
					diagnostic = terminalFailure(promptResult.stopReason, latestPermission);
					return {
						output: collectOutput(),
						...diagnostic === void 0 ? {} : { diagnostic },
						stopReason
					};
				} catch (error) {
					if (!flags.cancelled) {
						const outcome = await observeProcessOutcome(request.signal);
						diagnostic = diagnosticText(outcome === void 0 ? {
							stage: "prompt",
							category: "transport"
						} : {
							stage: "process",
							category: "process-exit",
							outcome
						}, latestPermission);
					}
					throw processFailure ?? error;
				}
			},
			collectOutput,
			collectDiagnostic: () => diagnostic,
			cancelled: () => flags.cancelled,
			onError: spec.onError,
			signal: request.signal,
			onAbort
		}),
		signal: request.signal,
		onAbort,
		requestCancel,
		teardown: async () => {
			await spec.transcript?.finish({
				stopReason: diagnostic === void 0 ? "completed" : "error",
				usage: terminal_usage
			});
			try {
				await disposeProcess();
			} catch (error) {
				reportFailure(spec, error);
				throw new AcpRunFailure({
					stage: "teardown",
					category: processOutcome === void 0 ? "unknown" : "process-exit",
					...processOutcome === void 0 ? {} : { outcome: processOutcome }
				}, error);
			}
		}
	});
}
//#endregion
//#region lib/types/transcript.js
/** Session key carried in the activation label as a trailing `[agy:<key>]` tag. */
function sessionKeyFromLabel(label) {
	const match = /\[agy:([A-Za-z0-9_-]{1,32})\]\s*$/.exec(label ?? "");
	return match === null ? void 0 : match[1];
}
/** Default transcript root: one directory per parent Session under the DSH home. */
function defaultTranscriptRoot() {
	return join(homedir(), ".dsh", "agy-runs");
}
/** Resolve the configured transcript root, expanding a leading `~`. */
function transcriptRoot(configured) {
	if (configured.length === 0) return defaultTranscriptRoot();
	return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
}
/** Read the persisted agy session id for one parent Session, only when the cwd still matches. */
async function readSessionRecord(path, cwd) {
	try {
		const record = JSON.parse(await readFile(path, "utf8"));
		if (record?.cwd === cwd && typeof record.sessionId === "string" && record.sessionId.length > 0) return record.sessionId;
		return void 0;
	} catch {
		return void 0;
	}
}
/** Persist the agy session id that a parent Session now delegates through. */
async function writeSessionRecord(path, record) {
	try {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, JSON.stringify(record, null, 2), "utf8");
	} catch {}
}
/** Text of one ACP content block or block array. */
function contentText(content) {
	if (Array.isArray(content)) return content.map((block) => block?.type === "text" ? block.text : "").join("");
	return content?.type === "text" ? content.text : "";
}
/**
* Append-only run transcript: one `.jsonl` of raw ACP updates plus a readable `.md`
* rendering, a `meta.json` summary, and a `latest.md` link for quick access.
*/
var RunTranscript = class {
	constructor(dir, meta) {
		this.dir = dir;
		this.meta = meta;
		this.startedAt = Date.now();
		this.replayed = 0;
		this.lastKind = "";
		this.terminal = {};
		this.ready = false;
	}
	async init() {
		try {
			await mkdir(this.dir, { recursive: true });
			this.jsonPath = join(this.dir, `${this.meta.stem}.jsonl`);
			this.mdPath = join(this.dir, `${this.meta.stem}.md`);
			this.metaPath = join(this.dir, `${this.meta.stem}.meta.json`);
			await appendFile(this.mdPath, `# agy run ${this.meta.runId}\n\n- parent session: ${this.meta.parentSessionId}\n- cwd: ${this.meta.cwd}\n- started: ${new Date(this.startedAt).toISOString()}\n\n`, "utf8");
			this.ready = true;
			await this.writeMeta();
			await this.linkLatest();
		} catch (error) {
			this.meta.warn?.(error);
		}
	}
	async writeMeta(extra = {}) {
		if (!this.ready) return;
		try {
			await writeFile(this.metaPath, JSON.stringify({
				runId: this.meta.runId,
				parentSessionId: this.meta.parentSessionId,
				cwd: this.meta.cwd,
				provider: this.meta.provider,
				model: this.meta.model,
				transcript: this.mdPath,
				startedAt: new Date(this.startedAt).toISOString(),
				...this.terminal,
				...extra
			}, null, 2), "utf8");
		} catch {}
	}
	async linkLatest() {
		for (const [target, name] of [[this.mdPath, "latest.md"], [this.metaPath, "latest.json"]]) try {
			await unlink(join(this.dir, name));
		} catch {}
		for (const [target, name] of [[this.mdPath, "latest.md"], [this.metaPath, "latest.json"]]) try {
			await symlink(target, join(this.dir, name));
		} catch {}
	}
	async block(text) {
		if (!this.ready) return;
		try { await appendFile(this.mdPath, text, "utf8"); } catch {}
	}
	async update(update, replay = false) {
		if (this.ready) try { await appendFile(this.jsonPath, JSON.stringify({ at: Date.now(), ...(replay ? { replay: true } : {}), ...update }) + "\n", "utf8"); } catch {}
		if (replay) {
			this.replayed += 1;
			return;
		}
		const kind = update.sessionUpdate;
		if (kind === "agent_message_chunk") {
			const text = contentText(update.content);
			if (text.length > 0) {
				if (this.lastKind !== "text") await this.block(this.lastKind === "" ? "## answer\n\n" : "\n\n## answer (continued)\n\n");
				this.lastKind = "text";
				await this.block(text);
			}
			return;
		}
		if (kind === "agent_thought_chunk") {
			const text = contentText(update.content);
			if (text.length > 0) {
				if (this.lastKind !== "thought") await this.block("\n\n<details><summary>thinking</summary>\n\n");
				this.lastKind = "thought";
				await this.block(text);
			}
			return;
		}
		if (kind === "tool_call") {
			this.lastKind = "tool";
			const raw = update.rawInput === void 0 ? "" : `\n\n\`\`\`json\n${JSON.stringify(update.rawInput, null, 2)}\n\`\`\``;
			await this.block(`\n\n### tool: ${update.title ?? update.kind ?? "tool"} (${update.kind ?? "other"})${raw}\n\n`);
			return;
		}
		if (kind === "tool_call_update") {
			const text = contentText(update.content) || (update.rawOutput === void 0 ? "" : JSON.stringify(update.rawOutput));
			await this.block(`\n\n> tool update (${update.status ?? "update"}): ${text.split("\n").join("\n> ")}\n\n`);
			return;
		}
		if (kind === "plan") {
			const entries = Array.isArray(update.entries) ? update.entries.map((e) => `- [${e.status ?? "?"}] ${e.content ?? ""}`).join("\n") : "";
			await this.block(`\n\n### plan\n\n${entries}\n\n`);
			return;
		}
	}
	async session(sessionId) {
		this.terminal.sessionId = sessionId;
		await this.writeMeta();
	}
	async finish(extra) {
		this.terminal = { ...this.terminal, ...extra, endedAt: new Date().toISOString() };
		if (this.lastKind === "thought") await this.block("\n\n</details>\n");
		if (this.replayed > 0) await this.block(`\n\n_(replayed ${this.replayed} history updates from the resumed conversation)_\n`);
		const usage = extra.usage;
		const line = usage === void 0 ? "" : `\n\n---\n\nusage: input ${usage.inputTokens ?? 0} · output ${usage.outputTokens ?? 0} · cache read ${usage.cachedReadTokens ?? 0} · thought ${usage.thoughtTokens ?? 0}\n`;
		await this.block(`\n${line}`);
		await this.writeMeta();
		await this.linkLatest();
	}
};
//#endregion
//#region lib/types/index.js
/**
* Out-of-process ACP subagent backend. Each child has its own process, session, model, and
* tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
* the subagent service supplies the captured child working directory. This plugin uses
* named exports only; a default would hide its
* loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
* @module @deepseek-ai/dsh-subagent-acp
*/
const name = "subagent-acp";
const inject = ["subagents", "subprocess"];
const Config = z.object({
	providerName: z.string().default("acp"),
	command: z.string().required(),
	args: z.array(z.string()).default([]),
	permission: z.union(["allow", "reject"]).default("reject"),
	env: z.dict(z.string()).default({}),
	disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
	model: z.string().default(""),
	reuseSession: z.boolean().default(true),
	transcriptDir: z.string().default("")
});
/** A process grace must fit every Node timer that observes or terminates the child. */
function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`subagent-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/** Resume the persisted agy session when possible, otherwise create a fresh one. */
async function resumeOrCreateSession(agent, spec) {
	if (spec.reuseSession && spec.resumeSessionId !== void 0) try {
		const loaded = await agent.request("session/load", {
			sessionId: spec.resumeSessionId,
			cwd: spec.cwd,
			mcpServers: []
		});
		loaded.resumed = true;
		return loaded;
	} catch (error) {
		spec.onNotice?.(`resume of ${spec.resumeSessionId} failed, starting a new session: ${toError(error).message}`);
	}
	const created = await agent.request(methods.agent.session.new, {
		cwd: spec.cwd,
		mcpServers: []
	});
	created.resumed = false;
	return created;
}
/**
* The ACP provider. Advertises NO start-time capabilities: an out-of-process
* child cannot honor `agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`.
* The service rejects a request needing any before execution starts.
*/
var AcpProvider = class {
	name;
	ctx;
	config;
	capabilities = {
		agentOptions: false,
		agentPreset: false,
		outputSchema: false,
		depthLimit: false
	};
	inheritsParentContext = false;
	constructor(name, ctx, config) {
		this.name = name;
		this.ctx = ctx;
		this.config = config;
	}
	async start(request) {
		if (request.signal.aborted) throw new Error("subagent request was aborted before the ACP child started");
		let cwd;
		try {
			cwd = assertUsableCwd("subagent-acp", "child cwd", request.cwd);
		} catch (error) {
			const failure = acpConfigurationFailure(error);
			this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error);
			throw failure;
		}
		const parentSessionId = String(request.parent?.session?.id ?? request.parent?.id ?? "unknown");
		const dir = join(transcriptRoot(this.config.transcriptDir), parentSessionId);
		const sessionKey = sessionKeyFromLabel(request.label) ?? parentSessionId;
		const recordPath = join(dir, "sessions", `${sessionKey}.json`);
		const runId = randomUUID();
		const transcript = new RunTranscript(dir, {
			runId,
			stem: `${new Date().toISOString().replace(/[:.]/g, "-")}-${runId.slice(0, 8)}`,
			parentSessionId,
			cwd,
			provider: this.name,
			model: this.config.model,
			warn: (error) => this.ctx.logger.warn(`subagent-agy "${this.name}": transcript unavailable: ${toError(error).message}`)
		});
		await transcript.init();
		const resumeSessionId = this.config.reuseSession ? await readSessionRecord(recordPath, cwd) : void 0;
		try {
			return await startAcpRun(request, {
				command: this.config.command,
				args: this.config.args,
				cwd,
				permission: this.config.permission,
				env: this.config.env,
				disposeEofGraceMs: this.config.disposeEofGraceMs,
				disposeGraceMs: this.config.disposeGraceMs,
				model: this.config.model,
				reuseSession: this.config.reuseSession,
				resumeSessionId,
				recordPath,
				transcript,
				onNotice: (message) => this.ctx.logger.info(`subagent-agy "${this.name}": ${message}`),
				spawn: (spec) => this.ctx.subprocess.spawn(spec),
				onError: (error, stopReason) => {
					this.ctx.logger.warn(`subagent-agy "${this.name}": child run failed (${stopReason}): ${error.message}`);
				}
			});
		} catch (error) {
			await transcript.finish({ stopReason: "error", error: toError(error).message });
			throw error;
		}
	}
};
function apply(ctx, config) {
	const resolved = config;
	assertPositiveFinite("disposeEofGraceMs", resolved.disposeEofGraceMs);
	assertPositiveFinite("disposeGraceMs", resolved.disposeGraceMs);
	ctx.subagents.registerProvider(new AcpProvider(resolved.providerName, ctx, resolved));
}
//#endregion
export { Config, apply, inject, name };
