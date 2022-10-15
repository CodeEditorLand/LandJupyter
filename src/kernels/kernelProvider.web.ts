// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';
import { inject, injectable, multiInject } from 'inversify';
import { IApplicationShell, IVSCodeNotebook } from '../platform/common/application/types';
import { InteractiveWindowView } from '../platform/common/constants';
import { NotebookDocument, Uri } from 'vscode';
import {
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposableRegistry,
    IExtensionContext
} from '../platform/common/types';
import { BaseCoreKernelProvider, BaseThirdPartyKernelProvider } from './kernelProvider.base';
import { Kernel, ThirdPartyKernel } from './kernel';
import {
    IThirdPartyKernel,
    IKernel,
    INotebookProvider,
    IStartupCodeProvider,
    ITracebackFormatter,
    KernelOptions,
    ThirdPartyKernelOptions
} from './types';
import { createKernelSettings } from './kernelSettings';
import { NotebookKernelExecution } from './kernelExecution';
import { KernelExecution, ThirdPartyKernelExecution } from './execution/kernelExecution';

/**
 * Web version of a kernel provider. Needed in order to create the web version of a kernel.
 */
@injectable()
export class KernelProvider extends BaseCoreKernelProvider {
    constructor(
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(IVSCodeNotebook) notebook: IVSCodeNotebook,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @multiInject(ITracebackFormatter) private readonly formatters: ITracebackFormatter[],
        @multiInject(IStartupCodeProvider) private readonly startupCodeProviders: IStartupCodeProvider[]
    ) {
        super(asyncDisposables, disposables, notebook);
    }

    public getOrCreate(notebook: NotebookDocument, options: KernelOptions): IKernel {
        const existingKernelInfo = this.getInternal(notebook);
        if (existingKernelInfo && existingKernelInfo.options.metadata.id === options.metadata.id) {
            return existingKernelInfo.kernel;
        }
        this.disposeOldKernel(notebook);

        const resourceUri = notebook?.notebookType === InteractiveWindowView ? options.resourceUri : notebook.uri;
        const settings = createKernelSettings(this.configService, resourceUri);
        const kernelExecution = new KernelExecution(
            options.controller,
            resourceUri,
            options.metadata,
            notebook,
            this.appShell,
            settings.interruptTimeout,
            this.context,
            this.formatters
        );
        const kernel = new Kernel(
            resourceUri,
            notebook,
            options.metadata,
            this.notebookProvider,
            settings,
            this.appShell,
            options.controller,
            this.startupCodeProviders,
            () => Promise.resolve(),
            kernelExecution
        ) as IKernel;
        kernel.onRestarted(() => this._onDidRestartKernel.fire(kernel), this, this.disposables);
        kernel.onDisposed(() => this._onDidDisposeKernel.fire(kernel), this, this.disposables);
        kernel.onStarted(() => this._onDidStartKernel.fire(kernel), this, this.disposables);
        kernel.onStatusChanged(
            (status) => this._onKernelStatusChanged.fire({ kernel, status }),
            this,
            this.disposables
        );
        this.executions.set(kernel, new NotebookKernelExecution(kernel, kernelExecution));
        this.asyncDisposables.push(kernel);
        this.storeKernel(notebook, options, kernel);

        this.deleteMappingIfKernelIsDisposed(kernel);
        return kernel;
    }
}

@injectable()
export class ThirdPartyKernelProvider extends BaseThirdPartyKernelProvider {
    constructor(
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(IVSCodeNotebook) notebook: IVSCodeNotebook,
        @multiInject(IStartupCodeProvider) private readonly startupCodeProviders: IStartupCodeProvider[]
    ) {
        super(asyncDisposables, disposables, notebook);
    }

    public getOrCreate(uri: Uri, options: ThirdPartyKernelOptions): IThirdPartyKernel {
        const existingKernelInfo = this.getInternal(uri);
        if (existingKernelInfo && existingKernelInfo.options.metadata.id === options.metadata.id) {
            return existingKernelInfo.kernel;
        }
        this.disposeOldKernel(uri);

        const resourceUri = uri;
        const settings = createKernelSettings(this.configService, resourceUri);
        const kernelExecution = new ThirdPartyKernelExecution(resourceUri, options.metadata, settings.interruptTimeout);
        const kernel = new ThirdPartyKernel(
            uri,
            resourceUri,
            options.metadata,
            this.notebookProvider,
            this.appShell,
            settings,
            this.startupCodeProviders,
            kernelExecution
        );
        kernel.onRestarted(() => this._onDidRestartKernel.fire(kernel), this, this.disposables);
        kernel.onDisposed(() => this._onDidDisposeKernel.fire(kernel), this, this.disposables);
        kernel.onStarted(() => this._onDidStartKernel.fire(kernel), this, this.disposables);
        kernel.onStatusChanged(
            (status) => this._onKernelStatusChanged.fire({ kernel, status }),
            this,
            this.disposables
        );
        this.asyncDisposables.push(kernel);

        this.storeKernel(uri, options, kernel);

        this.deleteMappingIfKernelIsDisposed(uri, kernel);
        return kernel;
    }
}
