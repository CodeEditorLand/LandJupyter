// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, multiInject, named } from "inversify";
import { Memento, NotebookDocument, Uri } from "vscode";

import {
	InteractiveWindowView,
	JupyterNotebookView,
} from "../platform/common/constants";
import {
	IAsyncDisposableRegistry,
	IConfigurationService,
	IDisposableRegistry,
	IExtensionContext,
	IMemento,
	WORKSPACE_MEMENTO,
} from "../platform/common/types";
import { IReplNotebookTrackerService } from "../platform/notebooks/replNotebookTrackerService";
import { IJupyterServerUriStorage } from "./jupyter/types";
import { Kernel, ThirdPartyKernel } from "./kernel";
import { NotebookKernelExecution } from "./kernelExecution";
import {
	BaseCoreKernelProvider,
	BaseThirdPartyKernelProvider,
} from "./kernelProvider.base";
import { createKernelSettings } from "./kernelSettings";
import {
	IKernel,
	IKernelSessionFactory,
	IStartupCodeProviders,
	IThirdPartyKernel,
	ITracebackFormatter,
	KernelOptions,
	ThirdPartyKernelOptions,
} from "./types";

/**
 * Node version of a kernel provider. Needed in order to create the node version of a kernel.
 */
@injectable()
export class KernelProvider extends BaseCoreKernelProvider {
	constructor(
		@inject(IAsyncDisposableRegistry)
		asyncDisposables: IAsyncDisposableRegistry,
		@inject(IDisposableRegistry) disposables: IDisposableRegistry,
		@inject(IKernelSessionFactory)
		private sessionCreator: IKernelSessionFactory,
		@inject(IConfigurationService)
		private configService: IConfigurationService,
		@inject(IExtensionContext) private readonly context: IExtensionContext,
		@inject(IJupyterServerUriStorage)
		jupyterServerUriStorage: IJupyterServerUriStorage,
		@multiInject(ITracebackFormatter)
		private readonly formatters: ITracebackFormatter[],
		@inject(IStartupCodeProviders)
		private readonly startupCodeProviders: IStartupCodeProviders,
		@inject(IMemento)
		@named(WORKSPACE_MEMENTO)
		private readonly workspaceStorage: Memento,
		@inject(IReplNotebookTrackerService)
		private readonly replTracker: IReplNotebookTrackerService,
	) {
		super(asyncDisposables, disposables);
		disposables.push(
			jupyterServerUriStorage.onDidRemove(
				this.handleServerRemoval.bind(this),
			),
		);
	}

	public getOrCreate(
		notebook: NotebookDocument,
		options: KernelOptions,
	): IKernel {
		const existingKernelInfo = this.getInternal(notebook);
		if (
			existingKernelInfo &&
			existingKernelInfo.options.metadata.id === options.metadata.id
		) {
			return existingKernelInfo.kernel;
		}
		this.disposeOldKernel(notebook);

		const replKernel = this.replTracker.isForReplEditor(notebook);
		const resourceUri = replKernel ? options.resourceUri : notebook.uri;
		const settings = createKernelSettings(this.configService, resourceUri);
		const startupCodeProviders = this.startupCodeProviders.getProviders(
			replKernel ? InteractiveWindowView : JupyterNotebookView,
		);

		const kernel: IKernel = new Kernel(
			resourceUri,
			notebook,
			options.metadata,
			this.sessionCreator,
			settings,
			options.controller,
			startupCodeProviders,
			this.workspaceStorage,
		);
		kernel.onRestarted(
			() => this._onDidRestartKernel.fire(kernel),
			this,
			this.disposables,
		);
		kernel.onDisposed(
			() => {
				this._onDidDisposeKernel.fire(kernel);
			},
			this,
			this.disposables,
		);
		kernel.onStarted(
			() => this._onDidStartKernel.fire(kernel),
			this,
			this.disposables,
		);
		kernel.onStatusChanged(
			(status) => this._onKernelStatusChanged.fire({ kernel, status }),
			this,
			this.disposables,
		);

		this.executions.set(
			kernel,
			new NotebookKernelExecution(
				kernel,
				this.context,
				this.formatters,
				notebook,
			),
		);
		this.asyncDisposables.push(kernel);
		this.storeKernel(notebook, options, kernel);
		this.deleteMappingIfKernelIsDisposed(kernel);
		return kernel;
	}
}

@injectable()
export class ThirdPartyKernelProvider extends BaseThirdPartyKernelProvider {
	constructor(
		@inject(IAsyncDisposableRegistry)
		asyncDisposables: IAsyncDisposableRegistry,
		@inject(IDisposableRegistry) disposables: IDisposableRegistry,
		@inject(IKernelSessionFactory)
		private sessionCreator: IKernelSessionFactory,
		@inject(IConfigurationService)
		private configService: IConfigurationService,
		@inject(IStartupCodeProviders)
		private readonly startupCodeProviders: IStartupCodeProviders,
		@inject(IMemento)
		@named(WORKSPACE_MEMENTO)
		private readonly workspaceStorage: Memento,
	) {
		super(asyncDisposables, disposables);
	}

	public getOrCreate(
		uri: Uri,
		options: ThirdPartyKernelOptions,
	): IThirdPartyKernel {
		const existingKernelInfo = this.getInternal(uri);
		if (
			existingKernelInfo &&
			existingKernelInfo.options.metadata.id === options.metadata.id
		) {
			return existingKernelInfo.kernel;
		}
		this.disposeOldKernel(uri);

		const resourceUri = uri;
		const settings = createKernelSettings(this.configService, resourceUri);
		const notebookType = resourceUri.path.endsWith(".interactive")
			? InteractiveWindowView
			: JupyterNotebookView;
		const kernel: IThirdPartyKernel = new ThirdPartyKernel(
			uri,
			resourceUri,
			options.metadata,
			this.sessionCreator,
			settings,
			this.startupCodeProviders.getProviders(notebookType),
			this.workspaceStorage,
		);
		kernel.onRestarted(
			() => this._onDidRestartKernel.fire(kernel),
			this,
			this.disposables,
		);
		kernel.onDisposed(
			() => {
				this._onDidDisposeKernel.fire(kernel);
			},
			this,
			this.disposables,
		);
		kernel.onStarted(
			() => this._onDidStartKernel.fire(kernel),
			this,
			this.disposables,
		);
		kernel.onStatusChanged(
			(status) => this._onKernelStatusChanged.fire({ kernel, status }),
			this,
			this.disposables,
		);
		this.asyncDisposables.push(kernel);
		this.storeKernel(uri, options, kernel);
		this.deleteMappingIfKernelIsDisposed(uri, kernel);
		return kernel;
	}
}
