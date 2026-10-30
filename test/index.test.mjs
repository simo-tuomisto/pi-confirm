/**
 * Tests for the pi-confirm extension.
 *
 * Loads the real extension (../index.ts) through the same jiti-based
 * loader that pi itself uses, then simulates tool_call events with a
 * mocked ExtensionContext/UI. Project settings are written to temporary
 * project directories (system temp dir), never to the repository.
 *
 * Run with: npm test   (or: node test/index.test.mjs)
 *
 * The @earendil-works/pi-coding-agent package is located automatically
 * (require.resolve, then `npm root -g`); set PI_CODING_AGENT_DIR to
 * override.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Locate the pi-coding-agent package (for jiti and the import alias)
// ---------------------------------------------------------------------------

function resolvePiDir() {
	const candidates = [];
	if (process.env.PI_CODING_AGENT_DIR) candidates.push(process.env.PI_CODING_AGENT_DIR);
	try {
		const resolved = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json");
		candidates.push(path.dirname(resolved));
	} catch {
		// Not resolvable from here; try the global npm root below.
	}
	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works", "pi-coding-agent"));
	} catch {
		// No npm on PATH.
	}
	for (const dir of candidates) {
		if (dir && fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	throw new Error("Cannot locate the @earendil-works/pi-coding-agent package; set PI_CODING_AGENT_DIR to its installation directory.");
}

function resolvePiEntry(piDir) {
	const pkg = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8"));
	const exportEntry = pkg.exports?.["."]?.import ?? pkg.exports?.["."]?.default ?? pkg.main ?? "dist/index.js";
	return path.join(piDir, exportEntry);
}

const piDir = resolvePiDir();
const requireFromPi = createRequire(path.join(piDir, "index.js"));
// jiti is a dependency of the pi package; locate its "./static" (ESM-only)
// entry through the package's own exports map.
const jitiMain = requireFromPi.resolve("jiti");
const jitiPkgDir = path.dirname(path.dirname(jitiMain));
const jitiPkg = JSON.parse(fs.readFileSync(path.join(jitiPkgDir, "package.json"), "utf8"));
const jitiStaticUrl = pathToFileURL(path.join(jitiPkgDir, jitiPkg.exports["./static"].import)).href;
const { createJiti } = await import(jitiStaticUrl);

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": resolvePiEntry(piDir) },
	moduleCache: false,
});
const extFactory = await jiti.import(EXT_PATH, { default: true });
if (typeof extFactory !== "function") throw new Error("extension default export is not a function");
console.log("✓ extension loaded (TS transpiled, imports resolved)");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tempDirs = [];
let passed = 0;
let failed = 0;
let seq = 0;

function check(cond, label) {
	if (cond) {
		passed++;
		console.log(`✓ ${label}`);
	} else {
		failed++;
		console.error(`✗ FAIL: ${label}`);
	}
}

function makeProject() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-confirm-test-${seq++}-`));
	tempDirs.push(dir);
	return dir;
}

function cleanup() {
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	}
}

function projectSettingsFile(dir) {
	return path.join(dir, ".pi", "settings.json");
}

function readProjectRules(dir) {
	try {
		const raw = JSON.parse(fs.readFileSync(projectSettingsFile(dir), "utf8"));
		return { "confirm-files": raw["confirm-files"] ?? {}, "confirm-commands": raw["confirm-commands"] ?? {} };
	} catch {
		return undefined;
	}
}

/** Install a fresh extension instance (== new session) with a mocked UI. */
function install(projectDir, { trusted = true, responder } = {}) {
	const toolCallHandlers = [];
	const commands = {};
	const selectCalls = [];
	const notifications = [];
	const pi = {
		on: (name, fn) => {
			if (name === "tool_call") toolCallHandlers.push(fn);
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
	};
	extFactory(pi);
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: {
			select: async (prompt, options) => {
				selectCalls.push({ prompt, options });
				// Default: allow once, so an unexpected dialog cannot crash the test.
				return responder ? responder(prompt, options) : options[0];
			},
			notify: (msg, level) => {
				notifications.push({ msg, level });
			},
		},
	};
	return {
		ctx,
		selectCalls,
		notifications,
		commands,
		call: async (toolName, input) => {
			const event = { type: "tool_call", toolCallId: `tc-${Math.random()}`, toolName, input };
			let result;
			for (const fn of toolCallHandlers) result = await fn(event, ctx);
			return result;
		},
	};
}

const pick = (options, substr) => {
	const opt = options.find((o) => o.toLowerCase().includes(substr));
	if (!opt) throw new Error(`option matching '${substr}' not found in ${JSON.stringify(options)}`);
	return opt;
};

// ---------------------------------------------------------------------------
// A: trusted project, bash -> "Allow ... in this project"
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, {
		responder: (_p, options) => pick(options, "in this project"),
	});
	const r1 = await t.call("bash", { command: "grep foo bar" });
	check(r1 === undefined, "A1: bash allowed after 'allow in this project'");
	check(t.selectCalls.length === 1, "A1: confirmation dialog was shown");
	check(
		JSON.stringify(t.selectCalls[0].options) === JSON.stringify(["Allow", 'Allow "grep" for this session', 'Allow "grep" in this project', "Deny"]),
		`A1: dialog offers exactly the four expected options (got ${JSON.stringify(t.selectCalls[0].options)})`,
	);
	const rules = readProjectRules(dir);
	check(rules?.["confirm-commands"]?.["grep"] === "allow", `A2: project settings contain grep=allow (got ${JSON.stringify(rules)})`);
	check(t.notifications.some((n) => n.msg.includes("Remembered for this project") && n.level === "info"), "A2: 'remembered for this project' notification");

	// A new session (fresh instance) in the same project must not ask again.
	const t2 = install(dir);
	const r2 = await t2.call("bash", { command: "grep -r x ." });
	check(r2 === undefined && t2.selectCalls.length === 0, "A3: new session: grep allowed from project settings without dialog");
}

// ---------------------------------------------------------------------------
// B: "Allow" (once) -> runs, nothing remembered
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: () => "Allow" });
	const r1 = await t.call("bash", { command: "ls -la" });
	check(r1 === undefined, "B1: 'Allow' runs the command");
	check(readProjectRules(dir) === undefined, "B1: 'Allow' writes no project rule");
	const r2 = await t.call("bash", { command: "ls -la" });
	check(r2 === undefined && t.selectCalls.length === 2, "B2: 'Allow' is not remembered -> asks again");
}

// ---------------------------------------------------------------------------
// C: "Allow ... for this session"
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: (_p, options) => pick(options, "for this session") });
	const r1 = await t.call("bash", { command: "date" });
	check(r1 === undefined, "C1: session remember runs the command");
	check(readProjectRules(dir) === undefined, "C1: session remember writes no project rule");
	const r2 = await t.call("bash", { command: "date --utc" });
	check(r2 === undefined && t.selectCalls.length === 1, "C2: session remember applies to rest of session");
}

// ---------------------------------------------------------------------------
// D: "Deny"
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: () => "Deny" });
	const r = await t.call("bash", { command: "whoami" });
	check(r?.block === true, "D1: 'Deny' blocks the command");
}

// ---------------------------------------------------------------------------
// E: untrusted project -> rule written but ignored (asks again), with note
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { trusted: false, responder: (_p, options) => pick(options, "in this project") });
	const r1 = await t.call("bash", { command: "echo hi" });
	check(r1 === undefined, "E1: untrusted: 'allow in this project' still runs the call");
	const rules = readProjectRules(dir);
	check(rules?.["confirm-commands"]?.["echo"] === "allow", "E2: untrusted: rule still written to project settings");
	check(t.notifications.some((n) => n.msg.includes("not trusted")), "E2: untrusted: notification mentions the project is not trusted");
	const r2 = await t.call("bash", { command: "echo hi again" });
	check(r2 === undefined && t.selectCalls.length === 2, "E3: untrusted: settings ignored -> asks again");
}

// ---------------------------------------------------------------------------
// F: write tool -> file path remembered in project settings
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const file = path.join(dir, "src", "new.txt");
	const t = install(dir, { responder: (_p, options) => pick(options, "in this project") });
	const r1 = await t.call("write", { path: "src/new.txt", content: "hello" });
	check(r1 === undefined, "F1: write allowed after 'allow in this project'");
	const rules = readProjectRules(dir);
	const fileRules = rules?.["confirm-files"] ?? {};
	const escaped = file.replace(/[\\*?\[\](){}!@+<>#]/g, "\\$&");
	check(fileRules[escaped] === "allow", `F2: escaped absolute path stored as allow (got ${JSON.stringify(fileRules)})`);
	check(t.selectCalls[0].options[0] === "Allow" && t.selectCalls[0].options[3] === "Deny", "F2: write dialog has four options");

	const t2 = install(dir);
	const r2 = await t2.call("write", { path: "src/new.txt", content: "again" });
	check(r2 === undefined && t2.selectCalls.length === 0, "F3: new session: same file allowed without dialog");

	// A different file must still ask.
	await t2.call("write", { path: "other.txt", content: "x" });
	check(t2.selectCalls.length === 1, "F4: different file still asks");
}

// ---------------------------------------------------------------------------
// G: edit tool
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: (_p, options) => pick(options, "in this project") });
	const r1 = await t.call("edit", { path: "a.go", edits: [{ oldText: "x", newText: "y" }] });
	check(r1 === undefined, "G1: edit allowed after 'allow in this project'");
	const rules = readProjectRules(dir);
	check(Object.values(rules?.["confirm-files"] ?? {}).includes("allow"), "G2: edit path stored in confirm-files");
}

// ---------------------------------------------------------------------------
// H: powershell
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: (_p, options) => pick(options, "in this project") });
	const r1 = await t.call("powershell", { command: "Get-Process | Select Name" });
	check(r1 === undefined, "H1: powershell allowed after 'allow in this project'");
	const rules = readProjectRules(dir);
	check(Object.values(rules?.["confirm-commands"] ?? {}).includes("allow"), "H2: whole command stored in confirm-commands");
	const t2 = install(dir);
	const r2 = await t2.call("powershell", { command: "Get-Process | Select Name" });
	check(r2 === undefined && t2.selectCalls.length === 0, "H3: new session: same powershell command allowed without dialog");
}

// ---------------------------------------------------------------------------
// I: whole-line (wrapper) bash -> still only Allow/Deny, no remembering
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	const t = install(dir, { responder: () => "Allow" });
	const r = await t.call("bash", { command: "sudo ls" });
	check(r === undefined, "I1: whole-line command allowed with 'Allow'");
	check(JSON.stringify(t.selectCalls[0].options) === JSON.stringify(["Allow", "Deny"]), `I2: whole-line dialog still has only Allow/Deny (got ${JSON.stringify(t.selectCalls[0].options)})`);
	check(readProjectRules(dir) === undefined, "I3: whole-line command not remembered");
}

// ---------------------------------------------------------------------------
// J: existing project settings file with other keys is preserved
// ---------------------------------------------------------------------------
{
	const dir = makeProject();
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(projectSettingsFile(dir), JSON.stringify({ theme: "dark", "confirm-commands": { git: "allow" } }, null, 2));
	const t = install(dir, { responder: (_p, options) => pick(options, "in this project") });
	await t.call("bash", { command: "grep foo" });
	const raw = JSON.parse(fs.readFileSync(projectSettingsFile(dir), "utf8"));
	check(
		raw.theme === "dark" && raw["confirm-commands"]?.git === "allow" && raw["confirm-commands"]?.grep === "allow",
		`J1: pre-existing keys preserved (got ${JSON.stringify(raw)})`,
	);
}

// ---------------------------------------------------------------------------
// K: registered slash commands still present
// ---------------------------------------------------------------------------
{
	const t = install(makeProject());
	check(typeof t.commands["confirm-files"]?.handler === "function" && typeof t.commands["confirm-commands"]?.handler === "function", "K1: /confirm-files and /confirm-commands still registered");
}

// ---------------------------------------------------------------------------

cleanup();
if (failed > 0) {
	console.error(`\n${failed} test(s) FAILED (${passed} passed)`);
	process.exit(1);
}
console.log(`\nALL TESTS PASSED (${passed} checks)`);
