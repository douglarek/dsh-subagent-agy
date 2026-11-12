import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/tool.js
/**
* Delegation tool for the Antigravity provider. Extends the shared delegation
* tool with a `session` argument that selects which Antigravity conversation the
* run continues, so independent tasks can run in parallel while a named task
* keeps its own history. The key travels to the provider in the activation
* label as a trailing `[agy:<key>]` tag, the only free-form field the subagent
* service passes through to an external provider.
*
* @module @deepseek-ai/dsh-subagent-agy/tool
*/
const name = "tool-subagent-agy";
const inject = ["tools", "subagents", "systemPrompt"];
const SESSION_KEY = /[A-Za-z0-9_-]{1,32}/;
/** Build the activation label that carries the optional session key. */
function activationLabel(description, session) {
	return session === void 0 ? description : `${description} [agy:${session}]`;
}
const Config = z.object({
	provider: z.string().default("agy"),
	toolName: z.string().default("subagent_agy")
});
/** Register the delegation tool while its provider exists, and re-register on changes. */
function apply(ctx, config) {
	const toolName = config.toolName;
	let dispose;
	const mount = (provider) => {
		if (dispose !== void 0) return;
		const definition = defineTool({
			name: toolName,
			description: "Delegate one self-contained task to Antigravity (agy) and return immediately with the child's name. " + "The runtime delivers a completion notice with the final answer. This backend does not accept follow-up messages. " + "Use `session` to name the Antigravity conversation: calls sharing a key continue one conversation and can run in sequence, " + "while different keys are independent and may run in parallel. Omit it to continue this DSH session's default conversation.",
			parameters: {
				session: {
					type: "string",
					description: "Optional conversation key: lower-case letters, digits, underscores and hyphens, at most 32 characters. Reuse a key to continue that Antigravity conversation; use different keys for independent parallel work."
				},
				description: {
					type: "string",
					required: true,
					description: "A short (3-5 word) description of the delegated task, for display. Use the language of the user's current request."
				},
				prompt: {
					type: "string",
					required: true,
					description: "The complete, self-contained task. Include all context the external agent needs; it cannot see this conversation."
				},
				cwd: {
					type: "string",
					description: "Initial child working directory. Relative paths use your current directory; omitted inherits it."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "activation"
						},
						name: {
							type: "string",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `started subagent ${value.name}`
				}],
				presentationMeta: (_args, value) => ({
					kind: value.kind,
					name: value.name
				})
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const parent = exec.agent;
				if (parent === void 0) throw new Error("subagent tool requires a calling agent");
				if (ctx.subagents.getProvider(config.provider) !== provider) throw new Error(`subagent provider "${config.provider}" changed; retry the delegation`);
				if (args.session !== void 0 && !SESSION_KEY.test(args.session) || args.session !== void 0 && args.session.match(/[^A-Za-z0-9_-]/) !== null) throw new Error("`session` must be 1-32 characters of lower-case letters, digits, underscores, or hyphens");
				exec.signal.throwIfAborted();
				const started = await ctx.subagents.startActivation({
					provider: config.provider,
					label: activationLabel(args.description, args.session),
					prompt: [{
						type: "text",
						text: args.prompt
					}],
					parent,
					...args.cwd === void 0 ? {} : { cwd: args.cwd },
					signal: exec.signal,
					delivery: "parent"
				});
				return {
					kind: "activation",
					name: started.name
				};
			}
		});
		const unregister = ctx.tools.register(definition);
		dispose = () => {
			unregister();
			dispose = void 0;
		};
	};
	ctx.on("subagent/provider-added", (provider) => {
		if (provider.name === config.provider) mount(provider);
	});
	ctx.on("subagent/provider-removed", (providerName) => {
		if (providerName === config.provider && dispose !== void 0) dispose();
	});
	const present = ctx.subagents.getProvider(config.provider);
	if (present !== void 0) mount(present);
	ctx.effect(() => () => {
		if (dispose !== void 0) dispose();
	}, `tool:${toolName}`);
}
//#endregion
export { Config, apply, inject, name };
