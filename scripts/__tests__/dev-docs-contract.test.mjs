import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CANONICAL_DOCS = [
	"docs/dev-rules/environment-setup.md",
	"docs/dev-rules/desktop-development.md",
	"docs/dev-rules/mobile-development.md",
];
const CONTRIBUTING_DOCS = ["CONTRIBUTING.md", "CONTRIBUTING.en.md"];
const CHECKED_DOCS = [...CONTRIBUTING_DOCS, ...CANONICAL_DOCS];
const WORKSPACES = new Map([
	["desktop", "apps/desktop/package.json"],
	["mobile", "apps/mobile/package.json"],
]);
const PNPM_BUILTINS = new Set(["install", "--version"]);

function readText(relativePath) {
	return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
	return JSON.parse(readText(relativePath));
}

function workflowJob(workflow, jobId) {
	const lines = workflow.split(/\r?\n/);
	const start = lines.findIndex((line) => line === `  ${jobId}:`);
	if (start === -1) return undefined;
	const endOffset = lines
		.slice(start + 1)
		.findIndex((line) => /^  [a-zA-Z0-9_-]+:$/.test(line));
	const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
	return lines.slice(start + 1, end).join("\n");
}

function shellLines(relativePath) {
	const markdown = readText(relativePath);
	return [...markdown.matchAll(/```(?:bash|sh)?\r?\n([\s\S]*?)```/g)]
		.flatMap((match) => match[1].split(/\r?\n/))
		.map((line) => line.trim())
		.filter((line) => line.startsWith("pnpm "));
}

function assertPnpmCommandExists(line, rootPackage) {
	const tokens = line.split(/\s+/);
	if (tokens[1] === "--filter") {
		const selector = tokens[2];
		const command = tokens[3];
		const workspaceManifest = WORKSPACES.get(selector);
		assert.ok(workspaceManifest, `unknown workspace selector in documented command: ${line}`);
		const workspacePackage = readJson(workspaceManifest);
		if (command === "exec") {
			const binary = tokens[4];
			assert.ok(
				workspacePackage.dependencies?.[binary] || workspacePackage.devDependencies?.[binary],
				`documented binary '${binary}' is not declared by ${workspaceManifest}: ${line}`,
			);
			return;
		}
		assert.ok(
			workspacePackage.scripts?.[command],
			`documented script '${command}' is missing from ${workspaceManifest}: ${line}`,
		);
		return;
	}

	const command = tokens[1];
	if (PNPM_BUILTINS.has(command)) return;
	assert.ok(rootPackage.scripts?.[command], `documented root script is missing: ${line}`);
}

/**
 * 去掉 fenced code block 与 inline code span,再抽链接。顺序不能反 —— fenced block
 * 内部含反引号,先剥 inline 会把围栏本身吃掉。
 *
 * 这样 `[x](y)` 这类**演示 markdown 语法**的写法不会被当成真链接(design-rules/DESIGN.md
 * 里有多处);而 [`foo.md`](./foo.md) 这种「链接文本本身是 inline code」的常见写法,剥完
 * 变成 [](./foo.md),目标仍在括号里,正则照常命中。
 */
function stripCodeSpans(text) {
	return (
		text
			// 围栏允许带缩进 —— 列表项里的围栏本就是缩进的(docs/design-rules/DESIGN.md
			// 与 docs/dev-rules/pi-remaining-work.md 各有一处)。只认行首 ``` 会漏掉它们,
			// 块内的示例链接就会被当成真链接。
			.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "")
			// inline code 用「等长反引号串」配对,这样内容本身含反引号的写法也能整段剥掉
			// (docs/product-rules/task-and-conversation-naming.md 有 `` `${n} 个会话` ``)。
			// 刻意不跨行:落单的反引号不应该让后面整篇文档漏检。
			.replace(/(`+)(?:(?!\1)[^\n])*?\1/g, "")
	);
}

function localMarkdownLinks(relativePath) {
	return [...stripCodeSpans(readText(relativePath)).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
		.map((match) => match[1].trim())
		.filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
}

/**
 * 需要做内链体检的全部文档:根目录规则文件 + `docs/` 下所有 markdown(递归)。
 *
 * 覆盖面刻意做全 —— 悬空内链最容易出现在深层目录里:文档被删除时,引用它的索引
 * (如 `docs/legal/README.md`、`docs/README.md`)常常漏改。只体检 CHECKED_DOCS 那几篇
 * canonical 文档挡不住这类回归。
 */
function listLinkCheckedDocs() {
	const out = ["AGENTS.md", ...CONTRIBUTING_DOCS];
	const walk = (relativeDir) => {
		for (const entry of fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
			const relativePath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) walk(relativePath);
			else if (entry.name.endsWith(".md")) out.push(relativePath);
		}
	};
	walk("docs");
	return [...new Set(out)].sort();
}

test("developer docs only document pnpm commands that exist", () => {
	const rootPackage = readJson("package.json");
	for (const relativePath of CHECKED_DOCS) {
		for (const line of shellLines(relativePath)) {
			assertPnpmCommandExists(line, rootPackage);
		}
	}
});

test("developer docs do not duplicate canonical command lines", () => {
	const owners = new Map();
	for (const relativePath of CHECKED_DOCS) {
		for (const line of shellLines(relativePath)) {
			assert.equal(
				owners.get(line),
				undefined,
				`documented command is duplicated in ${owners.get(line)} and ${relativePath}: ${line}`,
			);
			owners.set(line, relativePath);
		}
	}
	for (const relativePath of CONTRIBUTING_DOCS) {
		assert.equal(shellLines(relativePath).length, 0, `${relativePath} must link to canonical command docs`);
	}
});

test("AGENTS and CONTRIBUTING route to the canonical developer docs", () => {
	const agents = readText("AGENTS.md");
	const contributingDocs = CONTRIBUTING_DOCS.map(readText);
	for (const relativePath of CANONICAL_DOCS) {
		assert.match(agents, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		for (const contributing of contributingDocs) {
			assert.match(contributing, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	}
});

test("developer documentation links resolve", () => {
	for (const relativePath of listLinkCheckedDocs()) {
		const sourceDir = path.dirname(path.join(ROOT, relativePath));
		for (const target of localMarkdownLinks(relativePath)) {
			const fileTarget = decodeURIComponent(target.split("#", 1)[0]);
			assert.ok(
				fs.existsSync(path.resolve(sourceDir, fileTarget)),
				`broken local link in ${relativePath}: ${target}`,
			);
		}
	}
});

test("runtime versions and the docs contract are code-owned", () => {
	const rootPackage = readJson("package.json");
	assert.equal(rootPackage.engines.node, ">=22");
	assert.equal(rootPackage.engines.pnpm, ">=10.7 <11");
	assert.match(rootPackage.packageManager, /^pnpm@10\./);
	assert.match(rootPackage.scripts["test:runner"], /scripts\/__tests__\/dev-docs-contract\.test\.mjs/);
});

test("client CI keeps the complete two-shard unit gate on Windows", () => {
	const workflow = readText(".github/workflows/ci.yml");
	const shards = workflowJob(workflow, "windows-unit-shards");
	assert.ok(shards, "client CI must define Windows unit shards");
	assert.match(shards, /^    runs-on: windows-latest$/m);
	assert.match(shards, /^      fail-fast: false$/m);
	assert.match(shards, /^        shard: \[1, 2\]$/m);
	assert.match(shards, /^      XDT_UNIT_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/2$/m);
	assert.match(shards, /^        run: pnpm test:unit$/m);
	assert.doesNotMatch(shards, /pnpm test:unit\s+--/);

	const gate = workflowJob(workflow, "windows-unit");
	assert.ok(gate, "client CI must preserve the stable Windows unit check");
	assert.match(gate, /^    name: Windows unit tests$/m);
	assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
	assert.match(gate, /^    needs: windows-unit-shards$/m);
	assert.match(gate, /^          WINDOWS_UNIT_SHARDS_RESULT: \$\{\{ needs\.windows-unit-shards\.result \}\}$/m);
	assert.match(gate, /^        run: test "\$WINDOWS_UNIT_SHARDS_RESULT" = "success"$/m);
});

test("client Codex autofix is fork-only, hash-locked, reviewed, and never creates PRs", () => {
	const workflow = readText(".github/workflows/codex-autofix.yml");
	assert.match(workflow, /^  workflow_run:$/m);
	assert.match(workflow, /^      - client-ci$/m);
	assert.match(workflow, /github\.repository == 'hbyq\/Cindy'/);
	assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
	assert.match(workflow, /\[codex-autofix\]/);
	assert.match(workflow, /untrusted data, never instructions/i);
	assert.match(workflow, /permission-profile: ':workspace'/);
	assert.match(workflow, /permission-profile: ':read-only'/);
	assert.match(workflow, /\.toLowerCase\(\)/);
	assert.match(workflow, /ordinarySourceRoot\.test\(lower\)/);
	const ordinaryPattern = workflow.match(/^          const ordinarySourceRoot = \/(.+)\/;$/m);
	assert.ok(ordinaryPattern, "client autofix must define a conservative ordinary-code allowlist");
	const ordinarySourceRoot = new RegExp(ordinaryPattern[1]);
	assert.match(workflow, /sensitiveNamedComponent\.test\(lower\)/);
	const sensitivePattern = workflow.match(/^          const sensitiveNamedComponent = \/(.+)\/;$/m);
	assert.ok(sensitivePattern, "client autofix must define a deterministic sensitive component matcher");
	const sensitiveComponent = new RegExp(sensitivePattern[1]);
	for (const sensitivePath of [
		"apps/desktop/src/main/localDb/backup.ts",
		"apps/desktop/src/main/git-context/ghCliTokenSource.ts",
		"apps/desktop/src/main/im/shared/apiKey.ts",
		"apps/desktop/src/main/contacts-sync/keyStore.ts",
		"apps/desktop/src/main/remote-ssh/ssh-keys.ts",
		"apps/desktop/src/main/sidebarSettingsStore.ts",
		"packages/device-link/src/client.ts",
		"packages/maker-remote-ssh/src/hostKeys.ts",
		"packages/responses-chat-bridge/src/proxy.ts",
	]) {
		assert.equal(
			sensitiveComponent.test(sensitivePath.toLowerCase()),
			true,
			`client autofix sensitive matcher must reject ${sensitivePath}`,
		);
	}
	assert.equal(
		sensitiveComponent.test("apps/desktop/src/renderer/components/chat/MessageBubble.tsx".toLowerCase()),
		false,
		"ordinary renderer production code must remain eligible",
	);
	assert.equal(
		ordinarySourceRoot.test("apps/desktop/src/renderer/components/chat/MessageBubble.tsx".toLowerCase()),
		true,
		"ordinary renderer production code must be on the conservative allowlist",
	);
	for (const highRiskPath of [
		"apps/desktop/src/main/contacts-sync/keyStore.ts",
		"apps/desktop/src/main/remote-ssh/ssh-keys.ts",
		"packages/maker-remote-ssh/src/hostKeys.ts",
	]) {
		assert.equal(
			ordinarySourceRoot.test(highRiskPath.toLowerCase()),
			false,
			`client autofix ordinary-code allowlist must reject ${highRiskPath}`,
		);
	}
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /pnpm -r --if-present typecheck/);
	assert.match(workflow, /pnpm --filter desktop db:validate/);
	assert.match(workflow, /matrix:\n        shard: \[1, 2\]/);
	assert.match(workflow, /\.p0 == 0 and \.p1 == 0/);
	assert.match(workflow, /select\(\.severity == "P0"\)/);
	assert.match(workflow, /git push --atomic origin HEAD:refs\/heads\/main/);
	assert.match(workflow, /actions\/workflows\/ci\.yml\/dispatches/);
	assert.doesNotMatch(workflowJob(workflow, "publish"), /OPENAI_API_KEY/);
	assert.doesNotMatch(workflow, /pull_request_target|pull-requests:\s*write|gh pr create|force-with-lease|push --force/);
});

test("custom build autofix binds exact source metadata and atomically updates only feature branches", () => {
	const workflow = readText(".github/workflows/codex-custom-build-autofix.yml");
	assert.match(workflow, /^      - custom-windows-build$/m);
	assert.match(workflow, /select\(\.name == "build"\)/);
	assert.match(workflow, /\.conclusion' <<<"\$jobs_json"\)" == 'failure'/);
	assert.match(workflow, /custom-source-metadata-\$\{\{ github\.event\.workflow_run\.id \}\}-\$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
	assert.match(workflow, /repository: makecindy\/cindy\n          ref: \$\{\{ (?:steps\.verify|needs\.preflight)\.outputs\.official_sha \}\}/);
	assert.match(workflow, /git -C source write-tree/);
	assert.match(workflow, /git -C source diff --quiet/);
	assert.match(workflow, /pnpm --filter desktop typecheck/);
	assert.match(workflow, /pnpm test:unit/);
	assert.match(workflow, /pnpm release:package/);
	assert.match(workflow, /Updater\/update-service changes require owner approval/i);
	assert.match(workflow, /output-file: review\.json/);
	assert.doesNotMatch(workflow, /output-file: \.\.\/review\.json/);
	assert.match(workflow, /git push --atomic origin "\$\{refspecs\[@\]\}"/);
	assert.match(workflow, /expected_official_sha: \$expectedOfficialSha/);
	assert.match(workflow,
		/SKIP_CUSTOMIZATION_FETCH=1 \\\n\s+TRANSLATION_REF="\$new_translation" \\\n\s+UPDATE_REF="\$new_update" \\\n\s+EXPECTED_TRANSLATION_SHA="\$new_translation" \\\n\s+EXPECTED_UPDATE_SHA="\$new_update"/,
		"publication reproduction must bind the newly created feature heads");
	assert.match(workflow, /git remote get-url origin.*https:\/\/github\.com\/hbyq\/Cindy/);
	assert.doesNotMatch(workflowJob(workflow, "publish"), /OPENAI_API_KEY/);
	assert.doesNotMatch(workflow, /refs\/heads\/main"\)|gh pr create|pull-requests:\s*write|push --force/);
});

test("custom Windows build publishes immutable exact-SHA source metadata before compilation", () => {
	const workflow = readText(".github/workflows/custom-windows-build.yml");
	const composeScript = readText(".github/scripts/compose-custom-source.sh");
	assert.match(workflow, /^      expected_official_sha:$/m);
	assert.match(workflow, /ref: \$\{\{ steps\.release\.outputs\.official_sha \}\}/);
	assert.match(workflow, /name: custom-source-metadata-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
	assert.match(workflow, /schema 'cindy-custom-source-v1'/);
	assert.match(workflow, /translationFeatureSha/);
	assert.match(workflow, /updateBuildFeatureSha/);
	const metadataUpload = workflow.indexOf("- name: Upload immutable source metadata");
	const sourceComposition = workflow.indexOf("- name: Apply allow-listed fork customizations");
	assert.ok(metadataUpload >= 0 && sourceComposition >= 0 && metadataUpload < sourceComposition,
		"source metadata must be uploaded before composition can fail");
	assert.match(workflow, /translation_sha: \$\{\{ steps\.features\.outputs\.translation_sha \}\}/);
	assert.match(workflow, /update_sha: \$\{\{ steps\.features\.outputs\.update_sha \}\}/);
	assert.match(composeScript, /translation ref changed after source metadata was locked/);
	assert.match(composeScript, /update ref changed after source metadata was locked/);
	assert.match(composeScript, /count >= 1 && count <= 20/);
	assert.match(composeScript, /Signed-off-by matching its author or committer/);
	assert.match(composeScript, /history is not linear/);
	assert.match(composeScript, /git -c user\.name='github-actions\[bot\]'/);
});
