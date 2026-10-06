import type { ToolPresentation } from "./contracts.js";
import {
	buildEarlyPresentation,
	sanitizeModelFacingPresentation,
} from "./presentation/early-result.js";
import type { BuildToolPresentationOptions } from "./presentation/input-contracts.js";
import { applyPresentationNotices } from "./presentation/notices.js";
import { applyPresentationOutcome } from "./presentation/outcomes.js";
import {
	completePresentationOutput,
	extractPresentationArtifacts,
} from "./presentation/output-completion.js";
import {
	buildPresentationSource,
	buildSourcePresentation,
	resolvePresentationCommands,
} from "./presentation/source.js";

export async function buildToolPresentation(
	options: BuildToolPresentationOptions,
): Promise<ToolPresentation> {
	const commands = resolvePresentationCommands(options);
	const early = await buildEarlyPresentation(options, commands);
	if (early) {
		return early;
	}
	const source = buildPresentationSource(options, commands);
	const artifacts = await extractPresentationArtifacts(options, source);
	const draft = await buildSourcePresentation(options, source, artifacts, buildToolPresentation);
	applyPresentationNotices(draft, options, source);
	const completed = await completePresentationOutput(draft, options, source, artifacts);
	applyPresentationOutcome(completed, options, source);
	return sanitizeModelFacingPresentation(completed);
}
