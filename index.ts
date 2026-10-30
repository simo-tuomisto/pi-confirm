/**
 * pi-confirm: confirmation extension for file writes and shell commands
 *
 * Makes pi ask the user for confirmation before any tool call that can
 * edit or write files on the filesystem or run shell commands:
 *
 * - `bash`       -> the command line is parsed with tree-sitter-bash and
 *                   every distinct program it invokes (e.g. `grep` in
 *                   `ls && grep foo bar`) is checked SEPARATELY against
 *                   the `confirm-commands` settings.
 *                   If a wrapper command like `sudo` occurs anywhere in
 *                   the line (or the line cannot be parsed/identified),
 *                   the WHOLE command is checked as a single unit and
 *                   remembering is not offered.
 * - `powershell` -> the whole command (and its first word) is checked
 *                   against the `confirm-commands` settings
 * - `write`      -> the file path is checked against the
 *                   `confirm-files` settings (creates or overwrites a file)
 * - `edit`       -> the file path is checked against the
 *                   `confirm-files` settings (modifies a file)
 *
 * Each setting maps a pattern to one of three actions:
 *
 * - `allow`  the matching call runs without any confirmation
 * - `ask`    the user is asked for confirmation (the default when no
 *            pattern matches)
 * - `deny`   the matching call is always blocked
 *
 * When several patterns of the same layer match, the strictest action
 * wins (`deny` > `ask` > `allow`).
 *
 * Settings have two layers:
 *
 * 1. Session overrides, set at runtime with the commands below. They
 *    apply to the current session only and take precedence over the
 *    configuration file. They are cleared when the session ends, is
 *    replaced (/new, /resume, /fork), or pi is restarted.
 * 2. Permanent settings in pi's configuration file. The project
 *    settings (`.pi/settings.json`, honored only when the project is
 *    trusted) override the global settings
 *    (`~/.pi/agent/settings.json`) key by key:
 *
 *    {
 *      "confirm-files": {
 *        "*.go": "ask",
 *        "secrets/**": "deny",
 *        "/abs/path/or/relative/file": "allow"
 *      },
 *      "confirm-commands": {
 *        "rm": "deny",
 *        "git": "allow",
 *        "sudo*": "deny"
 *      }
 *    }
 *
 * Pattern matching (glob syntax, via minimatch with `dot: true`):
 *
 * - `confirm-files` patterns are matched against the file path used in
 *   the tool call: its absolute form, its form relative to the current
 *   working directory, and its basename. `*.go` therefore matches any
 *   Go file, while `src/**` matches everything under `src/` of the
 *   project.
 * - `confirm-commands` patterns are matched against the program name
 *   (basename of the invoked program, e.g. `grep`), the first word of
 *   the command line, and the whole (whitespace-normalized) command
 *   line. `rm` therefore denies any `rm` invocation, while
 *   `git push*` matches whole command lines starting with `git push`.
 *
 * The confirmation dialog offers up to four choices:
 *
 * - "Allow"                   permit just this single tool call
 * - "Allow ... for this session" remember the exact file path (write/
 *   edit), program name (bash) or whole command (powershell) as a
 *   session override with action `allow`
 * - "Allow ... in this project" remember the same pattern as a
 *   permanent `allow` rule in the project settings
 *   (.pi/settings.json), so it also applies in future sessions of this
 *   project (project settings are ignored while the project is not
 *   trusted)
 * - "Deny"                    block the tool call
 *
 * In non-interactive mode (no UI, e.g. `pi -p`) guarded calls resolve
 * to their configured action: `allow` runs, while `ask` and `deny`
 * block.
 *
 * Commands (same sub-forms for /confirm-files and /confirm-commands):
 * - /confirm-files                          show the effective settings
 * - /confirm-files <pattern> <action>       set a session override
 *                                          (action: allow | ask | deny)
 * - /confirm-files remove <pattern>         remove a session override
 * - /confirm-files clear                    clear all session overrides
 * - /confirm-files <pattern> <action> --project | --global
 * - /confirm-files remove <pattern> --project | --global
 *   With a scope flag, the rule is written to (or removed from) the
 *   permanent settings file instead of the session: --project targets
 *   .pi/settings.json, --global targets ~/.pi/agent/settings.json.
 */

import fs from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import { minimatch } from "minimatch";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const ALLOW = "Allow";
const DENY = "Deny";

/** The three actions a pattern can be mapped to. */
type ConfirmAction = "allow" | "ask" | "deny";

const ACTIONS: ConfirmAction[] = ["allow", "ask", "deny"];

/** Scope flags that redirect a rule change to a permanent settings file. */
const SCOPE_PROJECT = "--project";
const SCOPE_GLOBAL = "--global";
type RuleScope = "project" | "global";

/** Rank used so that the strictest matching action wins. */
const ACTION_RANK: Record<ConfirmAction, number> = { allow: 0, ask: 1, deny: 2 };

/** A map of pattern -> action, as read from settings or set at runtime. */
type RuleMap = Record<string, ConfirmAction>;

interface ParsedSettingsFile {
	files: RuleMap;
	commands: RuleMap;
	error?: string;
}

/** The settings of both layers after merging project over global. */
interface LoadedSettings {
	files: RuleMap;
	commands: RuleMap;
	globalFiles: RuleMap;
	globalCommands: RuleMap;
	projectFiles: RuleMap;
	projectCommands: RuleMap;
	globalPath: string;
	projectPath: string;
	projectTrusted: boolean;
}

/**
 * Programs that must never be remembered: when one of these appears as
 * a command anywhere in a bash line (including subshells, pipelines,
 * loops and command substitutions), the whole command is confirmed as a
 * single unit and the "remember" option is not offered, because the
 * program that actually runs is hidden in the arguments and cannot be
 * analyzed.
 */
const WRAPPER_COMMANDS = new Set<string>([
	// Privilege escalation: runs another program with different (usually
	// elevated) privileges.
	"sudo", "sudoedit", "su", "doas", "runuser", "pkexec",
	// Exec launchers: the program to run is given as an argument.
	"exec", "command", "nohup", "nice", "ionice", "setsid", "timeout", "time",
	"xargs", "watch", "chroot", "unshare", "nsenter", "ssh", "rsh",
	// Shells and interpreters: execute code supplied in the arguments or
	// read from a file.
	"bash", "sh", "dash", "ash", "zsh", "ksh", "fish",
	"python", "python2", "python3", "perl", "node", "nodejs", "ruby", "php",
	"lua", "tclsh", "awk", "gawk", "mawk",
	// Builtins that evaluate code from their arguments or a file.
	"eval", "source", ".",
]);

/**
 * Wrappers that only launch a program when one is actually given as an
 * argument. `env`, `env -i` and `env FOO=bar` without a trailing program
 * merely print the environment and are treated as a normal (rememberable)
 * command.
 */
const CONDITIONAL_WRAPPER_COMMANDS = new Set<string>(["env"]);

/** Lazily created tree-sitter parser, reused for the whole session. */
let bashParser: Parser | null = null;

function getBashParser(): Parser {
	if (!bashParser) {
		bashParser = new Parser();
		bashParser.setLanguage(Bash);
	}
	return bashParser;
}

/** Collapse whitespace so trivially equivalent shell commands map to the same list entry. */
function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/** Shorten long text for display in the dialog. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

/** Escape glob special characters so the text is stored as a literal pattern. */
function escapePattern(text: string): string {
	return text.replace(/[\\*?\[\](){}!@+<>#]/g, "\\$&");
}

/** Whether a glob pattern matches any of the candidate strings. */
function patternMatches(pattern: string, candidates: string[]): boolean {
	return candidates.some((candidate) => minimatch(candidate, pattern, { dot: true }));
}

/** The strictest action among the rules matching any candidate, or undefined when none match. */
function resolveAction(rules: RuleMap, candidates: string[]): ConfirmAction | undefined {
	let best: ConfirmAction | undefined;
	for (const [pattern, action] of Object.entries(rules)) {
		if (!patternMatches(pattern, candidates)) continue;
		if (best === undefined || ACTION_RANK[action] > ACTION_RANK[best]) best = action;
		if (best === "deny") return "deny";
	}
	return best;
}

/**
 * Resolve the effective action: session overrides take precedence over
 * the configuration file; the default when nothing matches is `ask`.
 */
function effectiveAction(
	sessionRules: Map<string, ConfirmAction>,
	configRules: RuleMap,
	candidates: string[],
): ConfirmAction {
	const session = resolveAction(Object.fromEntries(sessionRules), candidates);
	if (session !== undefined) return session;
	return resolveAction(configRules, candidates) ?? "ask";
}

/** The path candidates a `confirm-files` pattern is matched against. */
function fileCandidates(cwd: string, inputPath: string): string[] {
	const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
	const candidates = [abs];
	const rel = path.relative(cwd, abs);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) candidates.push(rel);
	const base = path.basename(abs);
	if (base && base !== "." && base !== abs) candidates.push(base);
	return candidates;
}

/** The command candidates a `confirm-commands` pattern is matched against. */
function commandCandidates(command: string): string[] {
	const normalized = normalizeCommand(command);
	const firstWord = normalized.split(" ")[0] ?? "";
	const candidates = [firstWord, normalized].filter(Boolean);
	return candidates;
}

/** Validate and extract the `confirm-files` / `confirm-commands` maps from one settings file. */
function parseSettingsFile(file: string): ParsedSettingsFile {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return { files: {}, commands: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { files: {}, commands: {}, error: err instanceof Error ? err.message : String(err) };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { files: {}, commands: {}, error: "the settings file is not a JSON object" };
	}
	const record = parsed as Record<string, unknown>;
	return {
		files: asRuleMap(record["confirm-files"]),
		commands: asRuleMap(record["confirm-commands"]),
	};
}

/** Coerce a settings value into a pattern -> action map, dropping invalid entries. */
function asRuleMap(value: unknown): RuleMap {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out: RuleMap = {};
	for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
		if (typeof pattern === "string" && pattern.length > 0 && ACTIONS.includes(action as ConfirmAction)) {
			out[pattern] = action as ConfirmAction;
		}
	}
	return out;
}

/** Read a settings file as a raw JSON object, or return {} when it does not exist. */
function readSettingsObject(file: string): { value: Record<string, unknown>; error?: string } {
	if (!fs.existsSync(file)) return { value: {} };
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { value: {}, error: err instanceof Error ? err.message : String(err) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { value: {}, error: err instanceof Error ? err.message : String(err) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { value: {}, error: "the settings file is not a JSON object" };
	}
	return { value: parsed as Record<string, unknown> };
}

/** Atomically write a settings object as pretty-printed JSON, creating parent directories. */
function writeSettingsObject(file: string, value: Record<string, unknown>): string | undefined {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Best effort: the temp file is in the same directory as the target.
		}
		return err instanceof Error ? err.message : String(err);
	}
	return undefined;
}

/** The settings-file key that holds the rules of the given kind. */
function sectionKey(kind: "files" | "commands"): string {
	return kind === "files" ? "confirm-files" : "confirm-commands";
}

/** The path of the permanent settings file for a scope flag. */
function settingsPath(scope: RuleScope, settings: LoadedSettings): string {
	return scope === "project" ? settings.projectPath : settings.globalPath;
}

/** Add or update a rule in the permanent settings file. Returns an error message or undefined. */
function writeRuleToSettings(kind: "files" | "commands", file: string, pattern: string, action: ConfirmAction): string | undefined {
	const { value, error } = readSettingsObject(file);
	if (error) return `cannot read ${file}: ${error}`;
	const key = sectionKey(kind);
	const section = asRuleMap(value[key]);
	section[pattern] = action;
	value[key] = section;
	const writeErr = writeSettingsObject(file, value);
	return writeErr ? `cannot write ${file}: ${writeErr}` : undefined;
}

/** Remove a rule (raw or escaped form) from the permanent settings file. */
function removeRuleFromSettings(kind: "files" | "commands", file: string, pattern: string): { removed: boolean; error?: string } {
	const { value, error } = readSettingsObject(file);
	if (error) return { removed: false, error: `cannot read ${file}: ${error}` };
	const key = sectionKey(kind);
	const section = asRuleMap(value[key]);
	const escaped = escapePattern(pattern);
	const hit = pattern in section ? pattern : escaped in section ? escaped : undefined;
	if (hit === undefined) return { removed: false };
	delete section[hit];
	value[key] = section;
	const writeErr = writeSettingsObject(file, value);
	return writeErr ? { removed: false, error: `cannot write ${file}: ${writeErr}` } : { removed: true };
}

/** Load the permanent settings from the global and project settings files. */
function loadSettings(ctx: ExtensionContext): LoadedSettings {
	const globalPath = path.join(getAgentDir(), "settings.json");
	const projectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
	const projectTrusted = ctx.isProjectTrusted();

	const global = parseSettingsFile(globalPath);
	const project = projectTrusted ? parseSettingsFile(projectPath) : { files: {}, commands: {} };

	const merge = (a: RuleMap, b: RuleMap): RuleMap => ({ ...a, ...b });
	return {
		files: merge(global.files, project.files),
		commands: merge(global.commands, project.commands),
		globalFiles: global.files,
		globalCommands: global.commands,
		projectFiles: project.files,
		projectCommands: project.commands,
		globalPath,
		projectPath,
		projectTrusted,
	};
}

/** A single simple command found in a bash command line. */
interface ParsedCommand {
	/** Base program name (basename of the first word), e.g. `grep`. */
	name: string;
	/** Source text of this simple command, for display. */
	text: string;
}

/** Result of analyzing a bash command line. */
type BashAnalysis =
	| {
			mode: "commands";
			/** Distinct programs, in order of first appearance. */
			commands: ParsedCommand[];
	  }
	| {
			mode: "whole";
			/** Why the command must be confirmed as a whole and cannot be remembered. */
			reason: string;
	  };

/**
 * Recursively collect all `command` nodes (simple commands) of a parse
 * tree, including commands inside subshells, pipelines, lists, loops,
 * command substitutions, process substitutions and function bodies.
 */
function collectCommandNodes(node: Parser.SyntaxNode, out: Parser.SyntaxNode[]): void {
	if (node.type === "command") out.push(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) collectCommandNodes(child, out);
	}
}

/**
 * Extract the base program name from a `command` node: the basename of
 * its first word, skipping leading `VAR=value` assignments (the grammar
 * puts the program in the `name` field). Returns undefined when the
 * program cannot be identified statically (e.g. `$CMD`, `$(...)`).
 */
function extractCommandName(cmd: Parser.SyntaxNode): string | undefined {
	const nameNode = cmd.childForFieldName("name");
	if (!nameNode) return undefined;
	// The grammar wraps the program in a `command_name` alias node; descend
	// to the actual literal (word, string, expansion, ...).
	const inner = nameNode.type === "command_name" ? nameNode.namedChild(0) ?? nameNode.child(0) : nameNode;
	if (!inner) return undefined;
	let raw: string;
	switch (inner.type) {
		case "word":
			raw = inner.text.replace(/\\(.)/g, "$1");
			break;
		case "string":
		case "raw_string":
			raw = inner.text.replace(/^(['"])([\s\S]*)\1$/, "$2");
			break;
		default:
			// Variable expansion, command substitution, concatenation, ...
			return undefined;
	}
	if (!raw) return undefined;
	const slash = raw.lastIndexOf("/");
	return slash === -1 ? raw : raw.slice(slash + 1);
}

/** Collect the raw source text of all arguments of a `command` node. */
function collectArguments(cmd: Parser.SyntaxNode): string[] {
	const args: string[] = [];
	for (let i = 0; i < cmd.childCount; i++) {
		if (cmd.fieldNameForChild(i) === "argument") {
			const child = cmd.child(i);
			if (child) args.push(child.text);
		}
	}
	return args;
}

/** True when the arguments of an `env` invocation contain a program to execute (after options and VAR=value assignments). */
function envRunsAProgram(args: string[]): boolean {
	for (const arg of args) {
		if (arg.startsWith("-")) continue; // option, e.g. -i, -0
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue; // VAR=value
		return true;
	}
	return false;
}

/**
 * Analyze a bash command line with tree-sitter-bash.
 *
 * - When the line cannot be parsed, contains a command whose program
 *   cannot be identified statically, or contains a wrapper command (e.g.
 *   `sudo`), returns `mode: "whole"`: the caller must check the whole
 *   command and must not offer remembering it.
 * - Otherwise returns `mode: "commands"` with the distinct programs
 *   (basenames of the first words) in order of first appearance.
 */
function analyzeBashCommand(command: string): BashAnalysis {
	if (!command.trim()) return { mode: "commands", commands: [] };

	let tree: Parser.Tree;
	try {
		const parser = getBashParser();
		parser.reset();
		tree = parser.parse(command);
	} catch {
		return { mode: "whole", reason: "the command line could not be parsed" };
	}
	if (tree.rootNode.hasError) {
		return { mode: "whole", reason: "the command line could not be fully parsed" };
	}

	const nodes: Parser.SyntaxNode[] = [];
	collectCommandNodes(tree.rootNode, nodes);
	if (nodes.length === 0) return { mode: "commands", commands: [] };

	const commands: ParsedCommand[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		const name = extractCommandName(node);
		if (name === undefined) {
			return {
				mode: "whole",
				reason: "it contains a command whose program cannot be identified statically",
			};
		}
		const conditionalWrapper = CONDITIONAL_WRAPPER_COMMANDS.has(name) && envRunsAProgram(collectArguments(node));
		if (WRAPPER_COMMANDS.has(name) || conditionalWrapper) {
			return {
				mode: "whole",
				reason: `it contains the wrapper command '${name}', which can execute an arbitrary program given in its arguments`,
			};
		}
		if (!seen.has(name)) {
			seen.add(name);
			commands.push({ name, text: node.text });
		}
	}
	return { mode: "commands", commands };
}

export default function (pi: ExtensionAPI) {
	/**
	 * Session-scoped overrides (the first settings layer). The extension
	 * instance (and therefore this closure) is recreated for every
	 * new/resumed/forked/reloaded session, so entries never survive
	 * across sessions. They take precedence over the permanent
	 * configuration file settings.
	 */
	const sessionFiles = new Map<string, ConfirmAction>();
	const sessionCommands = new Map<string, ConfirmAction>();

	// ------------------------------------------------------------------
	// Settings rendering (for the /confirm-files and /confirm-commands
	// commands with no arguments)
	// ------------------------------------------------------------------

	function renderSettings(kind: "files" | "commands", ctx: ExtensionContext): string {
		const label = kind === "files" ? "confirm-files" : "confirm-commands";
		const session = kind === "files" ? sessionFiles : sessionCommands;
		const settings = loadSettings(ctx);

		const lines: string[] = [`${label} settings (default when nothing matches: ask)`];

		lines.push(`  session overrides (this session only, override the configuration file): ${session.size === 0 ? "(none)" : ""}`);
		for (const [pattern, action] of session) lines.push(`    ${pattern} = ${action}`);

		lines.push(`  global config (${settings.globalPath}):`);
		const globalRules = kind === "files" ? settings.globalFiles : settings.globalCommands;
		const globalFile = parseSettingsFile(settings.globalPath);
		if (globalFile.error) lines.push(`    (error: ${globalFile.error})`);
		if (Object.keys(globalRules).length === 0 && !globalFile.error) lines.push("    (none)");
		for (const [pattern, action] of Object.entries(globalRules)) lines.push(`    ${pattern} = ${action}`);

		lines.push(`  project config (${settings.projectPath}):`);
		if (!settings.projectTrusted) {
			lines.push("    (ignored: project is not trusted)");
		} else {
			const projectRules = kind === "files" ? settings.projectFiles : settings.projectCommands;
			const projectFile = parseSettingsFile(settings.projectPath);
			if (projectFile.error) lines.push(`    (error: ${projectFile.error})`);
			if (Object.keys(projectRules).length === 0 && !projectFile.error) lines.push("    (none)");
			for (const [pattern, action] of Object.entries(projectRules)) lines.push(`    ${pattern} = ${action}`);
		}

		return lines.join("\n");
	}

	// ------------------------------------------------------------------
	// /confirm-files and /confirm-commands command handlers
	// ------------------------------------------------------------------

	function usage(kind: "files" | "commands"): string {
		const label = kind === "files" ? "confirm-files" : "confirm-commands";
		return [
			`/${label} [pattern <allow|ask|deny>]         set a session override for one pattern`,
			`/${label} [pattern <allow|ask|deny>] --project  write the rule to the project settings`,
			`/${label} [pattern <allow|ask|deny>] --global   write the rule to the global settings`,
			`/${label} remove <pattern>                    remove a session override`,
			`/${label} remove <pattern> --project          remove the rule from the project settings`,
			`/${label} remove <pattern> --global           remove the rule from the global settings`,
			`/${label} clear                               clear all session overrides`,
			`/${label}                                     show the effective settings`,
			``,
			`Session overrides last until the session ends (or /${label} clear).`,
			`--project writes to the project settings (${CONFIG_DIR_NAME}/settings.json),`,
			`--global writes to the global settings (~/.pi/agent/settings.json).`,
		].join("\n");
	}

	async function handleRulesCommand(kind: "files" | "commands", rawArgs: string | undefined, ctx: ExtensionContext): Promise<void> {
		const label = kind === "files" ? "confirm-files" : "confirm-commands";
		const session = kind === "files" ? sessionFiles : sessionCommands;

		// Extract the optional scope flag, which redirects the rule change
		// from the session to a permanent settings file.
		let scope: RuleScope | undefined;
		const args: string[] = [];
		for (const arg of (rawArgs ?? "").trim().split(/\s+/).filter(Boolean)) {
			if (arg === SCOPE_PROJECT || arg === SCOPE_GLOBAL) {
				if (scope !== undefined) {
					ctx.ui.notify(usage(kind), "error");
					return;
				}
				scope = arg === SCOPE_PROJECT ? "project" : "global";
			} else {
				args.push(arg);
			}
		}

		if (args.length === 0 && scope === undefined) {
			ctx.ui.notify(renderSettings(kind, ctx), "info");
			return;
		}

		const [first, second, ...rest] = args;

		if (first === "clear") {
			if (rest.length > 0 || second || scope !== undefined) {
				ctx.ui.notify(usage(kind), "error");
				return;
			}
			session.clear();
			ctx.ui.notify(`${label}: session overrides cleared`, "info");
			return;
		}

		if (first === "remove") {
			if (!second || rest.length > 0) {
				ctx.ui.notify(usage(kind), "error");
				return;
			}
			if (scope === undefined) {
				// Accept both the raw pattern and its escaped (remembered) form.
				const removed = session.delete(second) || session.delete(escapePattern(second));
				ctx.ui.notify(removed ? `${label}: removed session override for '${second}'` : `${label}: no session override for '${second}'`, removed ? "info" : "warning");
				return;
			}
			const settings = loadSettings(ctx);
			const target = settingsPath(scope, settings);
			// Accept both the raw pattern and its escaped (remembered) form.
			const result = removeRuleFromSettings(kind, target, second);
			if (result.error) {
				ctx.ui.notify(`${label}: ${result.error}`, "error");
			} else if (result.removed) {
				ctx.ui.notify(`${label}: removed '${second}' from ${scope} settings (${target})`, "info");
			} else {
				ctx.ui.notify(`${label}: no rule for '${second}' in ${scope} settings (${target})`, "warning");
			}
			return;
		}

		if (!second || rest.length > 0) {
			ctx.ui.notify(usage(kind), "error");
			return;
		}
		if (!ACTIONS.includes(second as ConfirmAction)) {
			ctx.ui.notify(`${label}: action must be one of: ${ACTIONS.join(", ")} (got '${second}')`, "error");
			return;
		}
		if (scope === undefined) {
			session.set(first, second as ConfirmAction);
			ctx.ui.notify(`${label}: ${first} = ${second} (this session only; use ${SCOPE_PROJECT} or ${SCOPE_GLOBAL} to make it permanent)`, "info");
			return;
		}
		const settings = loadSettings(ctx);
		const target = settingsPath(scope, settings);
		const err = writeRuleToSettings(kind, target, first, second as ConfirmAction);
		if (err) {
			ctx.ui.notify(`${label}: ${err}`, "error");
			return;
		}
		let message = `${label}: ${first} = ${second} written to ${scope} settings (${target})`;
		if (scope === "project" && !settings.projectTrusted) {
			message += `\nNote: the project is not trusted, so its settings are ignored until the project is trusted.`;
		}
		ctx.ui.notify(message, "info");
	}

	// ------------------------------------------------------------------
	// Tool call guarding
	// ------------------------------------------------------------------

	/**
	 * Persist a pattern with action `allow` in the project settings file
	 * (the "Allow ... in this project" dialog choice). Returns an error
	 * message when the write fails, or undefined on success. Notifies
	 * that the rule stays inactive while the project is not trusted.
	 */
	function rememberInProject(kind: "files" | "commands", pattern: string, display: string, ctx: ExtensionContext): string | undefined {
		const settings = loadSettings(ctx);
		const err = writeRuleToSettings(kind, settings.projectPath, pattern, "allow");
		if (err) return err;
		let message = `Remembered for this project: ${display}\nRule written to ${settings.projectPath}`;
		if (!settings.projectTrusted) {
			message += "\nNote: the project is not trusted, so its settings are ignored until the project is trusted.";
		}
		ctx.ui.notify(message, "info");
		return undefined;
	}

	/** Confirm a bash tool call: per program, or the whole line for wrappers/unparseable input. */
	async function handleBash(command: string, ctx: ExtensionContext): Promise<{ block: boolean; reason: string } | undefined> {
		const settings = loadSettings(ctx);
		const analysis = analyzeBashCommand(command);

		// Nothing executable (empty/whitespace-only, or a bare assignment):
		// there is no program to confirm.
		if (analysis.mode === "commands" && analysis.commands.length === 0) return undefined;

		// No UI to ask in: `allow` still runs, everything else is blocked.
		const noUi = (): { block: boolean; reason: string } => ({
			block: true,
			reason: "Blocked: this bash command requires confirmation, but no interactive UI is available.",
		});

		if (analysis.mode === "whole") {
			const candidates = commandCandidates(command);
			const action = effectiveAction(sessionCommands, settings.commands, candidates);
			if (action === "allow") return undefined;
			if (action === "deny") {
				return { block: true, reason: "Blocked: this bash command is denied by a confirm-commands setting." };
			}
			if (!ctx.hasUI) return noUi();

			const choice = await ctx.ui.select(
				`Run bash command?\n\n$ ${truncate(command, 400)}\n\n⚠ ${analysis.reason}.\nThis command is confirmed as a whole and cannot be remembered.`,
				[ALLOW, DENY],
			);
			if (choice === DENY) {
				return { block: true, reason: "Blocked: user denied this bash command." };
			}
			if (choice !== ALLOW) {
				return { block: true, reason: "Blocked: user dismissed the confirmation dialog." };
			}
			return undefined;
		}

		// Confirm each distinct program separately, in order of first
		// appearance; skip programs already allowed by the settings.
		const wholeLine = normalizeCommand(command);
		const programNames = analysis.commands.map((c) => c.name);
		for (const ref of analysis.commands) {
			// A pattern may match the program name or the whole command line.
			const action = effectiveAction(sessionCommands, settings.commands, [ref.name, wholeLine]);
			if (action === "allow") continue;
			if (action === "deny") {
				return { block: true, reason: `Blocked: '${ref.name}' in this bash command is denied by a confirm-commands setting.` };
			}
			if (!ctx.hasUI) return noUi();

			const sessionOption = `Allow "${ref.name}" for this session`;
			const projectOption = `Allow "${ref.name}" in this project`;
			const choice = await ctx.ui.select(
				`Run '${ref.name}' in bash?\n\nThis bash command runs ${programNames.length} program${programNames.length === 1 ? "" : "s"}: ${programNames.join(", ")}\n\nAs invoked here:\n$ ${truncate(ref.text, 200)}\n\n${sessionOption} allows any '${ref.name}' invocation (with any arguments) for the rest of this session.\n${projectOption} writes that rule to the project settings, so it also applies in future sessions of this project.`,
				[ALLOW, sessionOption, projectOption, DENY],
			);
			if (choice === DENY) {
				return { block: true, reason: `Blocked: user denied running '${ref.name}' in bash.` };
			}
			if (choice === undefined) {
				return { block: true, reason: "Blocked: user dismissed the confirmation dialog." };
			}
			if (choice === sessionOption) {
				sessionCommands.set(escapePattern(ref.name), "allow");
				ctx.ui.notify(`Remembered for this session: bash '${ref.name}' (any arguments)`, "info");
			} else if (choice === projectOption) {
				const err = rememberInProject("commands", escapePattern(ref.name), `bash '${ref.name}' (any arguments)`, ctx);
				if (err) ctx.ui.notify(`Could not write the project rule: ${err}`, "error");
			}
		}
		return undefined;
	}

	/** Confirm a write/edit tool call based on the `confirm-files` settings. */
	async function handleFile(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: boolean; reason: string } | undefined> {
		const isWrite = isToolCallEventType("write", event);
		const inputPath: string = event.input.path;
		const absPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(ctx.cwd, inputPath);

		const settings = loadSettings(ctx);
		const action = effectiveAction(sessionFiles, settings.files, fileCandidates(ctx.cwd, inputPath));
		if (action === "allow") return undefined;
		if (action === "deny") {
			return { block: true, reason: `Blocked: file '${inputPath}' is denied by a confirm-files setting.` };
		}
		if (!ctx.hasUI) {
			return { block: true, reason: "Blocked: this file operation requires confirmation, but no interactive UI is available." };
		}

		let title: string;
		let detail: string;
		if (isWrite) {
			const { content } = event.input as { path: string; content: string };
			title = "Write file?";
			detail = `Path: ${inputPath}\nSize: ${content.length} chars\n\nPreview:\n${truncate(content, 400)}`;
		} else {
			const { edits } = event.input as { path: string; edits: { oldText: string; newText: string }[] };
			const firstEdit = edits[0];
			const preview = firstEdit
				? `\n\nFirst edit:\n- ${truncate(firstEdit.oldText, 200)}\n+ ${truncate(firstEdit.newText, 200)}`
				: "";
			title = "Edit file?";
			detail = `Path: ${inputPath}\nEdits: ${edits.length}${preview}`;
		}

		const sessionOption = `Allow ${inputPath} for this session`;
		const projectOption = `Allow ${inputPath} in this project`;
		const choice = await ctx.ui.select(
			`${title}\n\n${detail}\n\n${projectOption} writes that rule to the project settings, so it also applies in future sessions of this project.`,
			[ALLOW, sessionOption, projectOption, DENY],
		);
		if (choice === undefined) {
			// User dismissed the dialog (e.g. Esc).
			return { block: true, reason: "Blocked: user dismissed the confirmation dialog." };
		}
		if (choice === DENY) {
			return { block: true, reason: "Blocked: user denied this tool call." };
		}
		if (choice === sessionOption) {
			sessionFiles.set(escapePattern(absPath), "allow");
			ctx.ui.notify(`Remembered for this session: file '${inputPath}'`, "info");
		} else if (choice === projectOption) {
			const err = rememberInProject("files", escapePattern(absPath), `file '${inputPath}'`, ctx);
			if (err) ctx.ui.notify(`Could not write the project rule: ${err}`, "error");
		}
		return undefined;
	}

	/** Confirm a powershell tool call based on the `confirm-commands` settings. */
	async function handlePowerShell(command: string, ctx: ExtensionContext): Promise<{ block: boolean; reason: string } | undefined> {
		const settings = loadSettings(ctx);
		const action = effectiveAction(sessionCommands, settings.commands, commandCandidates(command));
		if (action === "allow") return undefined;
		if (action === "deny") {
			return { block: true, reason: "Blocked: this PowerShell command is denied by a confirm-commands setting." };
		}
		if (!ctx.hasUI) {
			return { block: true, reason: "Blocked: this PowerShell command requires confirmation, but no interactive UI is available." };
		}

		const sessionOption = "Allow this command for this session";
		const projectOption = "Allow this command in this project";
		const choice = await ctx.ui.select(
			`Run PowerShell command?\n\nPS> ${truncate(command, 400)}\n\n${projectOption} writes that rule to the project settings, so it also applies in future sessions of this project.`,
			[ALLOW, sessionOption, projectOption, DENY],
		);
		if (choice === DENY) {
			return { block: true, reason: "Blocked: user denied this PowerShell command." };
		}
		if (choice === undefined) {
			return { block: true, reason: "Blocked: user dismissed the confirmation dialog." };
		}
		if (choice === sessionOption) {
			sessionCommands.set(escapePattern(normalizeCommand(command)), "allow");
			ctx.ui.notify(`Remembered for this session: PowerShell '${truncate(command, 60)}'`, "info");
		} else if (choice === projectOption) {
			const err = rememberInProject("commands", escapePattern(normalizeCommand(command)), `PowerShell '${truncate(command, 60)}'`, ctx);
			if (err) ctx.ui.notify(`Could not write the project rule: ${err}`, "error");
		}
		return undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			return handleBash(event.input.command, ctx);
		}
		if (isToolCallEventType("powershell", event)) {
			return handlePowerShell(event.input.command, ctx);
		}
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			return handleFile(event, ctx);
		}
		return undefined;
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify(
				"pi-confirm: file writes/edits and shell commands are checked against the confirm-files / confirm-commands settings (default: ask). Manage with /confirm-files and /confirm-commands",
				"info",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		sessionFiles.clear();
		sessionCommands.clear();
	});

	pi.registerCommand("confirm-files", {
		description: "confirm-files settings for write/edit paths; /confirm-files [pattern <allow|ask|deny> | remove <pattern> | clear] [--project|--global]",
		handler: async (args, ctx) => {
			await handleRulesCommand("files", args, ctx);
		},
	});

	pi.registerCommand("confirm-commands", {
		description: "confirm-commands settings for bash/powershell commands; /confirm-commands [pattern <allow|ask|deny> | remove <pattern> | clear] [--project|--global]",
		handler: async (args, ctx) => {
			await handleRulesCommand("commands", args, ctx);
		},
	});
}
