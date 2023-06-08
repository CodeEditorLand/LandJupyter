// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import {
    getDisplayNameOrNameOfKernelConnection,
    getKernelConnectionDisplayPath,
    getRemoteKernelSessionInformation
} from '../../kernels/helpers';
import { IJupyterServerUriStorage } from '../../kernels/jupyter/types';
import { KernelConnectionMetadata } from '../../kernels/types';
import { IWorkspaceService } from '../../platform/common/application/types';
import { IPlatformService } from '../../platform/common/platform/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { noop } from '../../platform/common/utils/misc';
import { IConnectionDisplayData, IConnectionDisplayDataProvider } from './types';
import {
    ConnectionDisplayData,
    getKernelConnectionCategory,
    getKernelConnectionCategorySync,
    getRemoteServerDisplayName
} from './connectionDisplayData';

@injectable()
export class ConnectionDisplayDataProvider implements IConnectionDisplayDataProvider {
    private readonly details = new Map<string, ConnectionDisplayData>();
    constructor(
        @inject(IWorkspaceService) private readonly workspace: IWorkspaceService,
        @inject(IPlatformService) private readonly platform: IPlatformService,
        @inject(IJupyterServerUriStorage) private readonly serverUriStorage: IJupyterServerUriStorage,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public getDisplayData(connection: KernelConnectionMetadata): IConnectionDisplayData {
        if (!this.details.get(connection.id)) {
            const label = getDisplayNameOrNameOfKernelConnection(connection);
            const description = getKernelConnectionDisplayPath(connection, this.workspace, this.platform);
            const detail =
                connection.kind === 'connectToLiveRemoteKernel' ? getRemoteKernelSessionInformation(connection) : '';
            const category = getKernelConnectionCategorySync(connection);
            const newDetails = new ConnectionDisplayData(connection.id, label, description, detail, category);
            this.disposables.push(newDetails);
            this.details.set(connection.id, newDetails);
        }
        const details: ConnectionDisplayData = this.details.get(connection.id)!;
        this.details.set(connection.id, details);

        if (connection.kind === 'connectToLiveRemoteKernel' || connection.kind === 'startUsingRemoteKernelSpec') {
            getRemoteServerDisplayName(connection, this.serverUriStorage)
                .then((displayName) => {
                    if (details.serverDisplayName !== displayName) {
                        details.serverDisplayName = displayName;

                        details.triggerChange();
                        return;
                    }
                })
                .catch(noop);
        }

        getKernelConnectionCategory(connection, this.serverUriStorage)
            .then((kind) => {
                if (details.category !== kind) {
                    details.category = kind;
                    details.triggerChange();
                }
            })
            .catch(noop);

        return details;
    }
}
