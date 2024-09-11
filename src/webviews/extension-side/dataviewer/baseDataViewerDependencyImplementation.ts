// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DataScience, Common } from '../../../platform/common/utils/localize';
import { IKernel } from '../../../kernels/types';
import { IDataViewerDependencyService } from './types';
import { pandasMinimumVersionSupportedByVariableViewer } from './constants';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { parseSemVer } from '../../../platform/common/utils';
import { SemVer } from 'semver';
import { capturePerfTelemetry, sendTelemetryEvent, Telemetry } from '../../../telemetry';
import { ProductNames } from '../../../platform/interpreter/installer/productNames';
import { Product } from '../../../platform/interpreter/installer/types';
import { CancellationToken, CancellationTokenSource, window } from 'vscode';
import { logger } from '../../../platform/logging';
import { isCodeSpace } from '../../../platform/constants';

/**
 * base class of the data viewer dependency implementation.
 */
export abstract class BaseDataViewerDependencyImplementation<TExecuter> implements IDataViewerDependencyService {
    abstract checkAndInstallMissingDependencies(executionEnvironment: IKernel | PythonEnvironment): Promise<void>;

    protected abstract _getVersion(executer: TExecuter, token: CancellationToken): Promise<string | undefined>;
    protected abstract _doInstall(executer: TExecuter, tokenSource: CancellationTokenSource): Promise<void>;

    protected async getVersion(executer: TExecuter, token: CancellationToken): Promise<SemVer | undefined> {
        try {
            const version = await this._getVersion(executer, token);
            return typeof version === 'string' ? parseSemVer(version) : version;
        } catch (e) {
            logger.warn(DataScience.failedToGetVersionOfPandas, e.message);
            return;
        }
    }

    @capturePerfTelemetry(Telemetry.PythonModuleInstall, {
        action: 'displayed',
        moduleName: ProductNames.get(Product.pandas)!
    })
    protected async promptInstall(
        executer: TExecuter,
        tokenSource: CancellationTokenSource,
        version?: string
    ): Promise<void> {
        let message = version
            ? DataScience.pandasTooOldForViewingFormat(version, pandasMinimumVersionSupportedByVariableViewer)
            : DataScience.pandasRequiredForViewing(pandasMinimumVersionSupportedByVariableViewer);

        let selection = isCodeSpace()
            ? Common.install
            : await window.showErrorMessage(message, { modal: true }, Common.install);

        if (selection === Common.install) {
            await this._doInstall(executer, tokenSource);
        } else {
            sendTelemetryEvent(Telemetry.UserDidNotInstallPandas);
            throw new Error(message);
        }
    }

    protected async checkOrInstall(executer: TExecuter): Promise<void> {
        const tokenSource = new CancellationTokenSource();

        try {
            const pandasVersion = await this.getVersion(executer, tokenSource.token);

            if (tokenSource.token.isCancellationRequested) {
                sendTelemetryEvent(Telemetry.PandasInstallCanceled);
                return;
            }

            if (pandasVersion) {
                if (pandasVersion.compare(pandasMinimumVersionSupportedByVariableViewer) > 0) {
                    sendTelemetryEvent(Telemetry.PandasOK);
                    return;
                }
                sendTelemetryEvent(Telemetry.PandasTooOld);
                // Warn user that we cannot start because pandas is too old.
                const versionStr = `${pandasVersion.major}.${pandasVersion.minor}.${pandasVersion.build}`;
                await this.promptInstall(executer, tokenSource, versionStr);
            }
            sendTelemetryEvent(Telemetry.PandasNotInstalled);
            await this.promptInstall(executer, tokenSource);
        } finally {
            tokenSource.dispose();
        }
    }
}
