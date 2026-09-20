import { sessionTransitionOverlayVisible } from "../agent/session-transition-controller.ts";
import { getActiveFonts } from "../fonts.ts";
import { getPierreThemes } from "../pierre-theme.ts";
import type { AppStateSnapshot } from "../state/app-store.ts";
import { workspaceChangeStats } from "../workspace-review-types.ts";

export type BackendSignals = {
	_codeThemeDark: string;
	_codeThemeLight: string;
	_fontMono: string;
	_fontSans: string;
	_promptHistory: readonly string[];
	_isBusy: boolean;
	_thinkingHidden: boolean;
	_temporarySession: boolean;
	_sessionTransitionGeneration: number;
	_sessionTransitionLoading: boolean;
	_sessionTransitionStatus: AppStateSnapshot["sessionTransition"]["status"];
	_sessionTransitionVisible: boolean;
	_workspaceReviewAdditions: number;
	_workspaceReviewBranch: string;
	_workspaceReviewDeletions: number;
	_workspaceReviewGitAvailable: boolean;
	_workspaceReviewChangeCount: number;
	_workspaceReviewStatsKnown: boolean;
};

export function projectBackendSignals(state: AppStateSnapshot): BackendSignals {
	const codeThemes = getPierreThemes();
	const fonts = getActiveFonts();
	const stats = workspaceChangeStats(state.workspaceReview.changes);
	return {
		_codeThemeDark: codeThemes.dark,
		_codeThemeLight: codeThemes.light,
		_fontMono: fonts.mono,
		_fontSans: fonts.sans,
		_promptHistory: state.promptHistory,
		_isBusy: Boolean(state.activityText),
		_thinkingHidden: state.thinkingHidden,
		_temporarySession: state.isTemporarySession,
		_sessionTransitionGeneration: state.sessionTransition.generation,
		_sessionTransitionLoading: state.sessionTransition.status === "loading",
		_sessionTransitionStatus: state.sessionTransition.status,
		_sessionTransitionVisible: sessionTransitionOverlayVisible(
			state.sessionTransition,
		),
		_workspaceReviewAdditions: stats.additions,
		_workspaceReviewBranch: state.workspaceReview.branch ?? "",
		_workspaceReviewDeletions: stats.deletions,
		_workspaceReviewGitAvailable: state.workspaceReview.isGitRepository,
		_workspaceReviewChangeCount: state.workspaceReview.changeCount,
		_workspaceReviewStatsKnown: stats.tracked,
	};
}
