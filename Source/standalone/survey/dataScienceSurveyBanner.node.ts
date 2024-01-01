// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from "inversify";
import {
	NotebookCellExecutionState,
	NotebookCellExecutionStateChangeEvent,
	UIKind,
	env,
	notebooks,
	window,
} from "vscode";
import { IExtensionSyncActivationService } from "../../platform/activation/types";
import { getVSCodeChannel } from "../../platform/common/application/applicationEnvironment";
import { openInBrowser } from "../../platform/common/net/browser";
import {
	BannerType,
	IDisposableRegistry,
	IJupyterExtensionBanner,
	IPersistentState,
	IPersistentStateFactory,
} from "../../platform/common/types";
import { isJupyterNotebook } from "../../platform/common/utils";
import * as localize from "../../platform/common/utils/localize";
import { noop } from "../../platform/common/utils/misc";
import { MillisecondsInADay, isCodeSpace } from "../../platform/constants.node";
import { traceError } from "../../platform/logging";

export const ISurveyBanner = Symbol("ISurveyBanner");
export interface ISurveyBanner
	extends IExtensionSyncActivationService,
		IJupyterExtensionBanner {}

export enum InsidersNotebookSurveyStateKeys {
	ShowBanner = "ShowInsidersNotebookSurveyBanner",
	ExecutionCount = "DS_InsidersNotebookExecutionCount",
}

export enum ExperimentNotebookSurveyStateKeys {
	ShowBanner = "ShowExperimentNotebookSurveyBanner",
	ExecutionCount = "DS_ExperimentNotebookExecutionCount",
}

enum DSSurveyLabelIndex {
	Yes = 0,
	No = 1,
}

export type ShowBannerWithExpiryTime = {
	/**
	 * This value is not used.
	 * We are only interested in the value for `expiry`.
	 * This structure is based on the old data for older customers when we used PersistentState class.
	 */
	data: boolean;
	/**
	 * If this is value `undefined`, then prompt can be displayed.
	 * If this value is `a number`, then a prompt was displayed at one point in time &
	 * we need to wait for Date.now() to be greater than that number to display it again.
	 */
	expiry?: number;
};

/**
 * Puts up a survey banner after a certain number of notebook executions. The survey will only show after 10 minutes have passed to prevent it from showing up immediately.
 */
@injectable()
export class DataScienceSurveyBanner
	implements IJupyterExtensionBanner, IExtensionSyncActivationService
{
	public isEnabled(type: BannerType): boolean {
		switch (type) {
			case BannerType.InsidersNotebookSurvey: {
				if (getVSCodeChannel() === "insiders") {
					return this.isEnabledInternal(type);
				}
				break;
			}
			case BannerType.ExperimentNotebookSurvey: {
				if (getVSCodeChannel() === "stable") {
					return this.isEnabledInternal(type);
				}
				break;
			}
			default: {
				traceError("Invalid Banner Type");
				return false;
			}
		}
		return false;
	}
	private isEnabledInternal(type: BannerType): boolean {
		if (env.uiKind !== UIKind.Desktop) {
			return false;
		}

		if (!this.showBannerState.get(type)?.value.expiry) {
			return true;
		}
		return this.showBannerState.get(type)?.value.expiry! < Date.now();
	}

	private disabledInCurrentSession = false;
	private bannerLabels: string[] = [
		localize.DataScienceSurveyBanner.bannerLabelYes,
		localize.DataScienceSurveyBanner.bannerLabelNo,
	];
	private readonly showBannerState = new Map<
		BannerType,
		IPersistentState<ShowBannerWithExpiryTime>
	>();
	private static surveyDelay = false;
	private readonly NotebookExecutionThreshold = 250; // Cell executions before showing survey

	constructor(
		@inject(IPersistentStateFactory)
		private persistentState: IPersistentStateFactory,
		@inject(IDisposableRegistry) private disposables: IDisposableRegistry
	) {
		this.setPersistentState(
			BannerType.InsidersNotebookSurvey,
			InsidersNotebookSurveyStateKeys.ShowBanner
		);
		this.setPersistentState(
			BannerType.ExperimentNotebookSurvey,
			ExperimentNotebookSurveyStateKeys.ShowBanner
		);

		// Change the surveyDelay flag after 10 minutes
		setTimeout(
			() => {
				DataScienceSurveyBanner.surveyDelay = true;
			},
			10 * 60 * 1000
		);
	}

	public activate() {
		notebooks.onDidChangeNotebookCellExecutionState(
			this.onDidChangeNotebookCellExecutionState,
			this,
			this.disposables,
		);
	}

	public async showBanner(type: BannerType): Promise<void> {
		const show = this.shouldShowBanner(type);
		if (!show) {
			return;
		}
		// Disable for the current session.
		this.disabledInCurrentSession = true;

		const response = await window.showInformationMessage(
			this.getBannerMessage(type),
			...this.bannerLabels,
		);
		switch (response) {
			case this.bannerLabels[DSSurveyLabelIndex.Yes]: {
				await this.launchSurvey(type);
				await this.disable(DSSurveyLabelIndex.Yes, type);
				break;
			}
			// Treat clicking on x as equivalent to clicking No
			default: {
				await this.disable(DSSurveyLabelIndex.No, type);
				break;
			}
		}
	}

	private shouldShowBanner(type: BannerType) {
		if (
			isCodeSpace() ||
			!this.isEnabled(type) ||
			this.disabledInCurrentSession ||
			!DataScienceSurveyBanner.surveyDelay
		) {
			return false;
		}

		const executionCount: number = this.getExecutionCount(type);

		return executionCount >= this.NotebookExecutionThreshold;
	}

	private setPersistentState(type: BannerType, val: string): void {
		this.showBannerState.set(
			type,
			this.persistentState.createGlobalPersistentState<ShowBannerWithExpiryTime>(
				val,
				{
					data: true,
				},
			),
		);
	}

	private async launchSurvey(type: BannerType): Promise<void> {
		openInBrowser(this.getSurveyLink(type));
	}
	private async disable(answer: DSSurveyLabelIndex, type: BannerType) {
		const monthsTillNextPrompt = answer === DSSurveyLabelIndex.Yes ? 6 : 4;

		if (monthsTillNextPrompt) {
			await this.showBannerState.get(type)?.updateValue({
				expiry:
					monthsTillNextPrompt * 31 * MillisecondsInADay + Date.now(),
				data: true,
			});
		}
	}

	private getExecutionCount(type: BannerType): number {
		switch (type) {
			case BannerType.InsidersNotebookSurvey:
				return this.getPersistentState(
					InsidersNotebookSurveyStateKeys.ExecutionCount,
				);
			case BannerType.ExperimentNotebookSurvey:
				return this.getPersistentState(
					ExperimentNotebookSurveyStateKeys.ExecutionCount,
				);
			default: {
				traceError("Invalid Banner type");
				return -1;
			}
		}
	}

	private getPersistentState(val: string): number {
		const state = this.persistentState.createGlobalPersistentState<number>(
			val,
			0,
		);
		return state.value;
	}

	// Handle when a cell finishes execution
	private async onDidChangeNotebookCellExecutionState(
		cellStateChange: NotebookCellExecutionStateChangeEvent,
	): Promise<void> {
		if (!isJupyterNotebook(cellStateChange.cell.notebook)) {
			return;
		}

		// If cell has moved to executing, update the execution count
		if (cellStateChange.state === NotebookCellExecutionState.Executing) {
			this.updateStateAndShowBanner(
				InsidersNotebookSurveyStateKeys.ExecutionCount,
				BannerType.InsidersNotebookSurvey,
			).catch(noop);
			this.updateStateAndShowBanner(
				ExperimentNotebookSurveyStateKeys.ExecutionCount,
				BannerType.ExperimentNotebookSurvey,
			).catch(noop);
		}
	}

	private async updateStateAndShowBanner(val: string, banner: BannerType) {
		const state = this.persistentState.createGlobalPersistentState<number>(
			val,
			0,
		);
		await state.updateValue(state.value + 1);
		this.showBanner(banner).catch(noop);
	}

	private getBannerMessage(type: BannerType): string {
		switch (type) {
			case BannerType.InsidersNotebookSurvey:
			case BannerType.ExperimentNotebookSurvey:
				return localize.InsidersNativeNotebooksSurveyBanner
					.bannerMessage;
			default: {
				traceError("Invalid Banner type");
				return "";
			}
		}
	}

	private getSurveyLink(type: BannerType): string {
		switch (type) {
			case BannerType.InsidersNotebookSurvey:
				return "https://aka.ms/vscjupyternb";
			case BannerType.ExperimentNotebookSurvey:
				return "https://aka.ms/vscnbexp";
			default: {
				traceError("Invalid Banner type");
				return "";
			}
		}
	}
}