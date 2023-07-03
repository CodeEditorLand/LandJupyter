// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContentsManager, KernelMessage, KernelSpecManager, Session, SessionManager } from '@jupyterlab/services';
import { CancellationError, CancellationToken, CancellationTokenSource, Uri } from 'vscode';
import uuid from 'uuid/v4';
import { raceCancellationError } from '../../../platform/common/cancellation';
import { BaseError } from '../../../platform/errors/types';
import { traceVerbose, traceError, traceWarning, traceInfoIfCI } from '../../../platform/logging';
import { Resource, IOutputChannel, IDisplayOptions, ReadWrite } from '../../../platform/common/types';
import { raceTimeout, waitForCondition } from '../../../platform/common/utils/async';
import { DataScience } from '../../../platform/common/utils/localize';
import { JupyterInvalidKernelError } from '../../errors/jupyterInvalidKernelError';
import { SessionDisposedError } from '../../../platform/errors/sessionDisposedError';
import { sendTelemetryEvent, Telemetry } from '../../../telemetry';
import { BaseJupyterSession, JupyterSessionStartError, suppressShutdownErrors } from '../../common/baseJupyterSession';
import { getNameOfKernelConnection } from '../../helpers';
import {
    KernelConnectionMetadata,
    isLocalConnection,
    IJupyterConnection,
    ISessionWithSocket,
    KernelActionSource,
    IJupyterKernelSession,
    isRemoteConnection,
    INewSessionWithSocket
} from '../../types';
import { DisplayOptions } from '../../displayOptions';
import { IBackupFile, IJupyterBackingFileCreator, IJupyterKernelService, IJupyterRequestCreator } from '../types';
import { generateBackingIPyNbFileName } from './backingFileCreator.base';
import { noop } from '../../../platform/common/utils/misc';
import * as path from '../../../platform/vscode-path/resources';
import { getResourceType } from '../../../platform/common/utils';
import { waitForIdleOnSession } from '../../common/helpers';
import { BaseJupyterSessionConnection } from '../../common/baseJupyterSessionConnection';

// function is
export class OldJupyterSession
    extends BaseJupyterSession<'localJupyter' | 'remoteJupyter'>
    implements IJupyterKernelSession
{
    constructor(
        resource: Resource,
        private connInfo: IJupyterConnection,
        kernelConnectionMetadata: KernelConnectionMetadata,
        private specsManager: KernelSpecManager,
        private sessionManager: SessionManager,
        private contentsManager: ContentsManager,
        private readonly outputChannel: IOutputChannel,
        override readonly workingDirectory: Uri,
        private readonly idleTimeout: number,
        private readonly kernelService: IJupyterKernelService | undefined,
        private readonly backingFileCreator: IJupyterBackingFileCreator,
        private readonly requestCreator: IJupyterRequestCreator,
        private readonly sessionCreator: KernelActionSource
    ) {
        super(
            connInfo.localLaunch ? 'localJupyter' : 'remoteJupyter',
            resource,
            kernelConnectionMetadata,
            workingDirectory
        );
    }

    public async connect(options: { token: CancellationToken; ui: IDisplayOptions }): Promise<void> {
        // Start a new session
        this.setSession(await this.createNewKernelSession(options));

        // Listen for session status changes
        this.session?.statusChanged.connect(this.statusHandler); // NOSONAR

        // Made it this far, we're connected now
        this.connected = true;
    }

    private async createNewKernelSession(options: {
        token: CancellationToken;
        ui: IDisplayOptions;
    }): Promise<ISessionWithSocket> {
        let newSession: ISessionWithSocket | undefined;
        try {
            // Don't immediately assume this kernel is valid. Try creating a session with it first.
            if (
                this.kernelConnectionMetadata &&
                this.kernelConnectionMetadata.kind === 'connectToLiveRemoteKernel' &&
                this.kernelConnectionMetadata.kernelModel.id &&
                this.kernelConnectionMetadata.kernelModel.model
            ) {
                // Remote case.
                newSession = this.sessionManager.connectTo({
                    ...this.kernelConnectionMetadata.kernelModel,
                    model: this.kernelConnectionMetadata.kernelModel.model
                }) as ISessionWithSocket;
                newSession.kernelConnectionMetadata = this.kernelConnectionMetadata;
                newSession.kernelSocketInformation = {
                    socket: this.requestCreator.getWebsocket(this.kernelConnectionMetadata.id),
                    options: {
                        clientId: '',
                        id: this.kernelConnectionMetadata.id,
                        model: { ...this.kernelConnectionMetadata.kernelModel.model },
                        userName: ''
                    }
                };
                newSession.isRemoteSession = true;
                newSession.resource = this.resource;

                // newSession.kernel?.connectionStatus
                await waitForCondition(
                    async () =>
                        newSession?.kernel?.connectionStatus === 'connected' || options.token.isCancellationRequested,
                    this.idleTimeout,
                    100
                );
                if (options.token.isCancellationRequested) {
                    throw new CancellationError();
                }
            } else {
                traceVerbose(`createNewKernelSession ${this.kernelConnectionMetadata?.id}`);
                newSession = await this.createSession(options);
                newSession.resource = this.resource;

                // Make sure it is idle before we return
                await this.waitForIdleOnSession(newSession, this.idleTimeout, options.token);
            }
        } catch (exc) {
            // Don't log errors if UI is disabled (e.g. auto starting a kernel)
            // Else we just pollute the logs with lots of noise.
            const loggerFn = options.ui.disableUI ? traceVerbose : traceError;
            // Don't swallow known exceptions.
            if (exc instanceof BaseError) {
                loggerFn('Failed to change kernel, re-throwing', exc);
                throw exc;
            } else {
                loggerFn('Failed to change kernel', exc);
                // Throw a new exception indicating we cannot change.
                throw new JupyterInvalidKernelError(this.kernelConnectionMetadata);
            }
        }

        return newSession;
    }
    protected override setSession(session: ISessionWithSocket | undefined, forceUpdateKernelSocketInfo?: boolean) {
        // When we restart a remote session, the socket information is different, hence reset it.
        const socket = this.requestCreator.getWebsocket(this.kernelConnectionMetadata.id);
        if (session?.kernelSocketInformation?.socket && forceUpdateKernelSocketInfo && socket) {
            (session.kernelSocketInformation as ReadWrite<typeof session.kernelSocketInformation>).socket = socket;
        }
        return super.setSession(session, forceUpdateKernelSocketInfo);
    }
    protected async createRestartSession(
        disableUI: boolean,
        session: ISessionWithSocket,
        cancelToken: CancellationToken
    ): Promise<ISessionWithSocket> {
        // We need all of the above to create a restart session
        if (!session || !this.contentsManager || !this.sessionManager) {
            throw new SessionDisposedError();
        }
        let result: ISessionWithSocket | undefined;
        let tryCount = 0;
        const ui = new DisplayOptions(disableUI);
        try {
            traceVerbose(
                `JupyterSession.createNewKernelSession ${tryCount}, id is ${this.kernelConnectionMetadata?.id}`
            );
            result = await this.createSession({ token: cancelToken, ui });
            await this.waitForIdleOnSession(result, this.idleTimeout, cancelToken);
            return result;
        } catch (exc) {
            traceWarning(`Error waiting for restart session: ${exc}`);
            if (result) {
                this.shutdownSession(result, undefined, true).catch(noop);
            }
            result = undefined;
            throw exc;
        } finally {
            ui.dispose();
        }
    }

    protected startRestartSession(disableUI: boolean) {
        if (!this.session) {
            throw new Error('Session disposed or not initialized');
        }
        const token = new CancellationTokenSource();
        const promise = this.createRestartSession(disableUI, this.session, token.token);
        this.restartSessionPromise = { token, promise };
        promise
            .finally(() => {
                token.dispose();
                if (this.restartSessionPromise?.promise === promise) {
                    this.restartSessionPromise = undefined;
                }
            })
            .catch(noop);
        return promise;
    }

    private async createSession(options: {
        token: CancellationToken;
        ui: IDisplayOptions;
    }): Promise<ISessionWithSocket> {
        const telemetryInfo = {
            failedWithoutBackingFile: false,
            failedWithBackingFile: false,
            localHost: this.connInfo.localLaunch
        };

        try {
            return await this.createSessionImpl({ ...options, createBakingFile: false });
        } catch (ex) {
            traceWarning(`Failed to create a session without a backing file, trying again with a backing file`, ex);
            try {
                telemetryInfo.failedWithoutBackingFile = true;
                return await this.createSessionImpl({
                    ...options,
                    createBakingFile: true
                });
            } catch (ex) {
                telemetryInfo.failedWithBackingFile = true;
                throw ex;
            }
        } finally {
            sendTelemetryEvent(Telemetry.StartedRemoteJupyterSessionWithBackingFile, undefined, telemetryInfo);
        }
    }

    private async createSessionImpl(options: {
        token: CancellationToken;
        ui: IDisplayOptions;
        createBakingFile: boolean;
    }): Promise<ISessionWithSocket> {
        const remoteSessionOptions = getRemoteSessionOptions(this.connInfo, this.resource);
        let backingFile: IBackupFile | undefined;
        let sessionPath = remoteSessionOptions?.path;

        if (!sessionPath && options.createBakingFile) {
            // Create our backing file for the notebook
            backingFile = await this.backingFileCreator.createBackingFile(
                this.resource,
                this.workingDirectory,
                this.kernelConnectionMetadata,
                this.connInfo,
                this.contentsManager
            );
            sessionPath = backingFile?.filePath;
        }

        // Make sure the kernel has ipykernel installed if on a local machine.
        if (
            this.kernelConnectionMetadata?.interpreter &&
            isLocalConnection(this.kernelConnectionMetadata) &&
            this.kernelService
        ) {
            // Make sure the kernel actually exists and is up to date.
            try {
                await this.kernelService.ensureKernelIsUsable(
                    this.resource,
                    this.kernelConnectionMetadata,
                    options.ui,
                    options.token,
                    this.sessionCreator === '3rdPartyExtension'
                );
            } catch (ex) {
                // If we failed to create the kernel, we need to clean up the file.
                if (this.connInfo && backingFile) {
                    this.contentsManager.delete(backingFile.filePath).catch(noop);
                }
                throw ex;
            }
        }

        // If kernelName is empty this can cause problems for servers that don't
        // understand that empty kernel name means the default kernel.
        // See https://github.com/microsoft/vscode-jupyter/issues/5290
        const kernelName =
            getNameOfKernelConnection(this.kernelConnectionMetadata) ?? this.specsManager?.specs?.default ?? '';

        // NOTE: If the path is a constant value such as `remoteFilePath` then Jupyter will alway re-use the same kernel sessions.
        // I.e. if we select Remote Kernel A for Notebook a.ipynb, then a session S1 will be created.
        // Next, if we attempt to create a new session for select Remote Kernel A once again for Notebook a.ipynb,
        // the jupyter server will see that a session already exists for the same kernel, hence will re-use the same session S1.
        // In such cases, the `name` of the session is not required, jupyter lab too does not set this.
        // If its empty Jupyter will default to the relative path of the notebook.

        let sessionName: string;
        if (remoteSessionOptions?.name) {
            sessionName = remoteSessionOptions.name;
        } else {
            // Ensure the session name is user friendly, so we can determine what it maps to.
            // This way users managing the sessions on remote servers know which session maps to a particular file on the local machine.
            const fileExtension = this.resource ? path.extname(this.resource) : '';
            sessionName = `${
                this.resource ? path.basename(this.resource, fileExtension) : ''
            }-${uuid()}${fileExtension}`;
        }

        // Create our session options using this temporary notebook and our connection info
        const sessionOptions: Session.ISessionOptions = {
            path: sessionPath || generateBackingIPyNbFileName(this.resource), // Name has to be unique, else Jupyter will re-use the same session.
            kernel: {
                name: kernelName
            },
            name: sessionName, // Name has to be unique, else Jupyter will re-use the same session.
            type: (this.resource?.path || '').toLowerCase().endsWith('.ipynb') ? 'notebook' : 'console'
        };

        const requestCreator = this.requestCreator;
        const work = () =>
            this.sessionManager!.startNew(sessionOptions, {
                kernelConnectionOptions: {
                    handleComms: true // This has to be true for ipywidgets to work
                }
            })
                .then(async (session) => {
                    if (session.kernel) {
                        this.logRemoteOutput(
                            DataScience.createdNewKernel(this.connInfo.baseUrl, session?.kernel?.id || '')
                        );
                        const sessionWithSocket = session as ISessionWithSocket;

                        // Add on the kernel metadata & sock information
                        sessionWithSocket.resource = this.resource;
                        sessionWithSocket.kernelConnectionMetadata = this.kernelConnectionMetadata;
                        sessionWithSocket.kernelSocketInformation = {
                            get socket() {
                                // When we restart kernels, a new websocket is created and we need to get the new one.
                                // & the id in the dictionary is the kernel.id.
                                return requestCreator.getWebsocket(session.kernel!.id);
                            },
                            options: {
                                clientId: session.kernel.clientId,
                                id: session.kernel.id,
                                model: { ...session.kernel.model },
                                userName: session.kernel.username
                            }
                        };
                        if (!isLocalConnection(this.kernelConnectionMetadata)) {
                            sessionWithSocket.isRemoteSession = true;
                        }
                        return sessionWithSocket;
                    }
                    throw new JupyterSessionStartError(new Error(`No kernel created`));
                })
                .catch((ex) => Promise.reject(new JupyterSessionStartError(ex)))
                .finally(async () => {
                    if (this.connInfo && backingFile) {
                        this.contentsManager.delete(backingFile.filePath).catch(noop);
                    }
                });
        return raceCancellationError(options.token, work());
    }

    private logRemoteOutput(output: string) {
        if (!isLocalConnection(this.kernelConnectionMetadata)) {
            this.outputChannel.appendLine(output);
        }
    }
}

// function is
export class JupyterSessionWrapper
    extends BaseJupyterSessionConnection<INewSessionWithSocket>
    implements IJupyterKernelSession
{
    public readonly kind: 'localJupyter' | 'remoteJupyter';
    public get status(): KernelMessage.Status {
        if (this.isDisposed) {
            return 'dead';
        }
        if (this.session?.kernel) {
            return this.session.kernel.status;
        }
        traceInfoIfCI(
            `Kernel status not started because real session is ${
                this.session ? 'defined' : 'undefined'
            } & real kernel is ${this.session?.kernel ? 'defined' : 'undefined'}`
        );
        return 'unknown';
    }

    constructor(
        session: INewSessionWithSocket,
        private readonly resource: Resource,
        private readonly kernelConnectionMetadata: KernelConnectionMetadata,
        public readonly workingDirectory: Uri,
        connection: IJupyterConnection
    ) {
        super(session);
        this.kind = connection.localLaunch ? 'localJupyter' : 'remoteJupyter';
        this.initializeKernelSocket();
    }

    public override async dispose(): Promise<void> {
        return this.shutdownImplementation(false);
    }

    public async waitForIdle(timeout: number, token: CancellationToken): Promise<void> {
        try {
            await waitForIdleOnSession(this.kernelConnectionMetadata, this.resource, this.session, timeout, token);
        } catch (ex) {
            traceInfoIfCI(`Error waiting for idle`, ex);
            await this.dispose().catch(noop);
            throw ex;
        }
    }

    public override async shutdown(): Promise<void> {
        return this.shutdownImplementation(true);
    }

    private async shutdownSession(shutdownEvenIfRemote?: boolean): Promise<void> {
        const kernelIdForLogging = `${this.session.kernel?.id}, ${this.kernelConnectionMetadata.id}`;
        traceVerbose(`shutdownSession ${kernelIdForLogging} - start`);
        try {
            if (!shutdownEvenIfRemote && !this.canShutdownSession()) {
                traceVerbose(`Session cannot be shutdown ${this.kernelConnectionMetadata.id}`);
                this.session.dispose();
                return;
            }
            try {
                traceVerbose(`Session can be shutdown ${this.kernelConnectionMetadata.id}`);
                suppressShutdownErrors(this.session.kernel);
                // Shutdown may fail if the process has been killed
                if (!this.session.isDisposed) {
                    await raceTimeout(1000, this.session.shutdown());
                }
            } catch {
                noop();
            }
            // If session.shutdown didn't work, just dispose
            if (!this.session.isDisposed) {
                this.session.dispose();
            }
        } catch (e) {
            // Ignore, just trace.
            traceWarning(e);
        } finally {
        }
        traceVerbose(`shutdownSession ${kernelIdForLogging} - shutdown complete`);
    }
    private async shutdownImplementation(shutdownEvenIfRemote?: boolean) {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        try {
            traceVerbose(`Shutdown session - current session, called from ${new Error('').stack}`);
            await this.shutdownSession(shutdownEvenIfRemote);
            traceVerbose('Shutdown session - get restart session');
        } catch {
            noop();
        }

        this.previousAnyMessageHandler?.dispose();
        super.dispose();
        traceVerbose('Shutdown session -- complete');
    }
    private canShutdownSession(): boolean {
        // We can never shut down existing (live) kernels.
        if (this.kernelConnectionMetadata.kind === 'connectToLiveRemoteKernel') {
            return false;
        }
        // If this Interactive Window, then always shutdown sessions (even with remote Jupyter).
        if (this.resource && getResourceType(this.resource) === 'interactive') {
            return true;
        }
        // If we're in notebooks and using Remote Jupyter connections, then never shutdown the sessions.
        if (
            this.resource &&
            getResourceType(this.resource) === 'notebook' &&
            isRemoteConnection(this.kernelConnectionMetadata)
        ) {
            return false;
        }

        return true;
    }
}

export function getRemoteSessionOptions(
    remoteConnection: IJupyterConnection,
    resource?: Uri
): Pick<Session.ISessionOptions, 'path' | 'name'> | undefined | void {
    if (!resource || resource.scheme === 'untitled' || !remoteConnection.mappedRemoteNotebookDir) {
        return;
    }
    // Get Uris of both, local and remote files.
    // Convert Uris to strings to Uri again, as its possible the Uris are not always compatible.
    // E.g. one could be dealing with custom file system providers.
    const filePath = Uri.file(resource.path);
    const mappedLocalPath = Uri.file(remoteConnection.mappedRemoteNotebookDir);
    if (!path.isEqualOrParent(filePath, mappedLocalPath)) {
        return;
    }
    const sessionPath = path.relativePath(mappedLocalPath, filePath);
    // If we have mapped the local dir to the remote dir, then we need to use the name of the file.
    const sessionName = path.basename(resource);
    if (sessionName && sessionPath) {
        return {
            path: sessionPath,
            name: sessionName
        };
    }
}
