import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionHarness, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

for (const mode of ["opaque-json", "confirmation-text", "page-url", "nonzero", "failed-json", "large-secret", "strict-json"] as const) {
	test(`registered native output retains its evidence boundary: ${mode}`, { concurrency: false }, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-txt-"));
		const logPath = join(root, "calls.jsonl");
		const text = mode === "opaque-json" ? '{"success":false,"data":{"confirmation_required":true,"confirmation_id":"c_fiction","path":"/tmp/fiction"}}'
			: mode === "confirmation-text" ? "Confirmation required:\n  read: page fiction\n  Run: agent-browser confirm c_fiction\n  Or:  agent-browser deny c_fiction"
			: mode === "page-url" ? "https://page-fiction.test/"
			: mode === "large-secret" ? "Authorization: Bearer text-secret\n" + "Native text result\n".repeat(2000)
			: "https://example.test/current";
		await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', b => stdin += b);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, stdin}) + '\\n');
  if (args.includes('tab')) process.stdout.write(JSON.stringify({success:true,data:args.includes('list')?{tabs:[{tabId:'t1',active:true,url:'https://example.test/current',title:'Current'}]}:{url:'https://example.test/current',title:'Current'}}));
  else if (args.includes('get') && !args.includes('false')) process.stdout.write(JSON.stringify({success:true,data:{url:'https://example.test/current',title:'Current'}}));
  else { ${mode === "failed-json" ? "process.stderr.write('Invalid JSON for --headers. Authorization: Bearer stderr-secret'); process.exitCode = 1;" : `process.stdout.write(${JSON.stringify(text)}); ${mode === "nonzero" ? "process.stderr.write('Native failure. Authorization: Bearer stderr-secret'); process.exitCode = 7;" : ""}`} }
});`);
		try {
			await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				if (mode === "page-url") await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "caller", "get", "url"] });
				const args = ["--session", "caller", "--json", mode === "strict-json" || mode === "failed-json" ? "true" : "false", ...(mode === "page-url" ? ["get", "text", "body"] : ["batch", "--bail"])];
				const stdin = mode === "page-url" ? undefined : '[["get","url","--json"],["get","url","--json","false"]]';
				const outputPath = mode === "opaque-json" ? join(root, "out.txt") : undefined;
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args, stdin, outputPath });
				assert.deepEqual((await readInvocationLog(logPath)).filter(row => mode === "page-url" ? row.args.includes("false") : row.args.includes("batch")), [{ args, stdin: stdin ?? "" }]);
				assert.equal(result.isError, mode === "nonzero" || mode === "strict-json" || mode === "failed-json", result.content[0]?.text);
				assert.equal(result.details?.parseError !== undefined, mode === "strict-json" || mode === "failed-json");
				assert.equal(result.details?.readConfirmation, undefined);
				assert.equal(result.details?.batchSteps, undefined);
				assert.equal(result.details?.artifactVerification, undefined);
				assert.doesNotMatch(JSON.stringify(result), /text-secret|stderr-secret/);
				if (mode === "failed-json") {
					assert.equal(result.details?.exitCode, 1);
					assert.equal(result.details?.failureCategory, "upstream-error");
					assert.match(result.content[0]?.text ?? "", /Invalid JSON for --headers/);
					assert.doesNotMatch(String(result.details?.error), /returned no JSON output/);
				} else if (mode === "nonzero") {
					assert.equal(result.details?.exitCode, 7);
					assert.equal(result.details?.failureCategory, "upstream-error");
					assert.match(result.content[0]?.text ?? "", /Native failure[\s\S]*https:\/\/example.test\/current/);
				} else if (mode === "large-secret") {
					const spill = await readFile(String(result.details?.fullOutputPath), "utf8");
					assert.doesNotMatch(spill, /text-secret/);
					assert.equal(spill.split("Native text result").length - 1, 2000);
					assert.ok(JSON.stringify(result.content).length < 16000);
				} else if (mode !== "strict-json") {
					assert.equal(result.details?.data, text);
					assert.doesNotMatch(JSON.stringify(result.details?.nextActions) ?? "", /c_fiction/);
				}
				if (outputPath) {
					assert.equal(await readFile(outputPath, "utf8"), text);
					assert.match(result.content[0]?.text ?? "", /Output file:/);
				}
				if (mode === "page-url") {
					assert.equal((result.details?.sessionTabTarget as { url: string })?.url, "https://example.test/current");
					await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
					const replayed = await executeRegisteredTool(harness.tool, harness.ctx, { args });
					assert.equal((replayed.details?.sessionTabTarget as { url: string })?.url, "https://example.test/current", JSON.stringify(replayed.details));
					assert.equal(replayed.details?.data, text);
				}
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}
