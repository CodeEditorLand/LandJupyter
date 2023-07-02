// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Kernel, KernelMessage, Session } from '@jupyterlab/services';
import type { Slot } from '@lumino/signaling';
import { CancellationError, CancellationTokenSource, Event, EventEmitter, Uri } from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import { Cancellation, isCancellationError, raceCancellationError } from '../../../platform/common/cancellation';
import { getTelemetrySafeErrorMessageFromPythonTraceback } from '../../../platform/errors/errorUtils';
import { traceInfo, traceError, traceVerbose, traceWarning, traceInfoIfCI } from '../../../platform/logging';
import { IDisplayOptions, IDisposable, Resource } from '../../../platform/common/types';
import { createDeferred, raceTimeout, sleep } from '../../../platform/common/utils/async';
import { DataScience } from '../../../platform/common/utils/localize';
import { StopWatch } from '../../../platform/common/utils/stopWatch';
import { sendKernelTelemetryEvent } from '../../telemetry/sendKernelTelemetryEvent';
import { trackKernelResourceInformation } from '../../telemetry/helper';
import { Telemetry } from '../../../telemetry';
import { getDisplayNameOrNameOfKernelConnection } from '../../../kernels/helpers';
import {
    IBaseKernelSession,
    IRawKernelSession,
    ISessionWithSocket,
    KernelConnectionMetadata,
    KernelSocketInformation
} from '../../../kernels/types';
import { BaseJupyterSession, suppressShutdownErrors } from '../../common/baseJupyterSession';
import { IKernelLauncher, IKernelProcess } from '../types';
import { OldRawSession, RawSession } from './rawSession.node';
import { DisplayOptions } from '../../displayOptions';
import { noop } from '../../../platform/common/utils/misc';
import { KernelProgressReporter } from '../../../platform/progress/kernelProgressReporter';
import { disposeAllDisposables } from '../../../platform/common/helpers';
import { JupyterInvalidKernelError } from '../../errors/jupyterInvalidKernelError';
import { KernelConnectionWrapper } from '../../common/kernelConnectionWrapper';
import { waitForIdleOnSession } from '../../common/helpers';
import { ReplaySubject } from 'rxjs/ReplaySubject';
import { Observable } from 'rxjs/Observable';

/*
RawJupyterSession is the implementation of IJupyterKernelConnectionSession that instead of
connecting to JupyterLab services it instead connects to a kernel directly
through ZMQ.
It's responsible for translating our IJupyterKernelConnectionSession interface into the
jupyterlabs interface as well as starting up and connecting to a raw session
*/
export class OldRawJupyterSession extends BaseJupyterSession<'localRaw'> implements IRawKernelSession {
    private processExitHandler = new WeakMap<OldRawSession, IDisposable>();
    private terminatingStatus?: KernelMessage.Status;
    public get atleastOneCellExecutedSuccessfully() {
        if (this.session && this.session instanceof OldRawSession) {
            return this.session.atleastOneCellExecutedSuccessfully;
        }
        return false;
    }
    public override get status(): KernelMessage.Status {
        if (this.terminatingStatus && super.status !== 'dead') {
            return this.terminatingStatus;
        }
        return super.status;
    }
    constructor(
        private readonly kernelLauncher: IKernelLauncher,
        resource: Resource,
        workingDirectory: Uri,
        kernelConnection: KernelConnectionMetadata,
        private readonly launchTimeout: number
    ) {
        super('localRaw', resource, kernelConnection, workingDirectory);
    }

    // Connect to the given kernelspec, which should already have ipykernel installed into its interpreter
    public async connect(options: { token: CancellationToken; ui: IDisplayOptions }): Promise<void> {
        // Save the resource that we connect with
        let newSession: OldRawSession;
        await trackKernelResourceInformation(this.resource, { kernelConnection: this.kernelConnectionMetadata });
        try {
            // Try to start up our raw session, allow for cancellation or timeout
            // Notebook Provider level will handle the thrown error
            newSession = await this.startRawSession({ ...options, purpose: 'start' });
            Cancellation.throwIfCanceled(options.token);
            this.setSession(newSession);

            // Listen for session status changes
            this.session?.statusChanged.connect(this.statusHandler); // NOSONAR
        } catch (error) {
            this.connected = false;
            if (isCancellationError(error) || options.token.isCancellationRequested) {
                traceVerbose('Starting of raw session cancelled by user');
                throw error;
            } else {
                traceError(`Failed to connect raw kernel session: ${error}`);
                throw error;
            }
        }

        this.connected = true;
    }

    protected override shutdownSession(
        session: OldRawSession | undefined,
        statusHandler: Slot<ISessionWithSocket, KernelMessage.Status> | undefined,
        isRequestToShutdownRestartSession: boolean | undefined
    ): Promise<void> {
        // Remove our process exit handler. Kernel is shutting down on purpose
        // so we don't need to listen to shutdown anymore.
        const disposable = session && this.processExitHandler.get(session);
        disposable?.dispose();
        // We want to know why we got shut down
        const stacktrace = new Error().stack;
        return super.shutdownSession(session, statusHandler, isRequestToShutdownRestartSession).then(() => {
            sendKernelTelemetryEvent(this.resource, Telemetry.RawKernelSessionShutdown, undefined, {
                isRequestToShutdownRestartSession,
                stacktrace
            });
            if (session) {
                return session.kernelProcess.dispose();
            }
        });
    }

    protected override setSession(session: OldRawSession | undefined) {
        if (session) {
            traceInfo(
                `Started Kernel ${getDisplayNameOrNameOfKernelConnection(this.kernelConnectionMetadata)} (pid: ${
                    session.kernelProcess.pid
                })`
            );
        }
        super.setSession(session);
        if (!session) {
            return;
        }
        this.terminatingStatus = undefined;
        // Watch to see if our process exits
        // This is the place to do this, after this session has been setup as the active kernel.
        const disposable = session.kernelProcess.exited(({ exitCode, reason }) => {
            // If this session is no longer the active session, then we don't need to do anything
            // with this exit event (could be we're killing it, or restarting).
            // In the case of restarting, the old session is disposed & a new one created.
            // When disposing the old kernel we shouldn't fire events about session getting terminated.
            if (session !== this.session) {
                return;
            }
            sendKernelTelemetryEvent(
                this.resource,
                Telemetry.RawKernelSessionKernelProcessExited,
                exitCode ? { exitCode } : undefined,
                {
                    exitReason: getTelemetrySafeErrorMessageFromPythonTraceback(reason)
                }
            );
            traceError(`Raw kernel process exited code: ${exitCode}`);

            // If the raw kernel process dies, then send the terminating event, and shutdown the session.
            // Afer shutting down the session, the status changes to `dead`
            this.terminatingStatus = 'terminating';
            this.onStatusChangedEvent.fire('terminating');
            // Shutdown the session but not this class.
            this.setSession(undefined);
            this.shutdownSession(session, this.statusHandler, false)
                .catch((reason) => {
                    traceError(`Error shutting down jupyter session: ${reason}`);
                })
                .finally(() => {
                    // If we're still terminanting this session,
                    // trigger dead status
                    if (this.terminatingStatus) {
                        this.terminatingStatus = 'dead';
                        this.onStatusChangedEvent.fire('dead');
                    }
                });
        });
        this.disposables.push(disposable);
        this.processExitHandler.set(session, disposable);
    }

    protected startRestartSession(disableUI: boolean) {
        const token = new CancellationTokenSource();
        const promise = this.createRestartSession(disableUI, token.token);
        this.restartSessionPromise = { token, promise };
        promise.catch(noop);
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
    private async createRestartSession(
        disableUI: boolean,
        cancelToken: CancellationToken
    ): Promise<ISessionWithSocket> {
        if (!this.kernelConnectionMetadata || this.kernelConnectionMetadata.kind === 'connectToLiveRemoteKernel') {
            throw new Error('Unsupported - unable to restart live kernel sessions using raw kernel.');
        }
        return this.startRawSession({ token: cancelToken, ui: new DisplayOptions(disableUI), purpose: 'restart' });
    }

    private async startRawSession(options: {
        token: CancellationToken;
        ui: IDisplayOptions;
        purpose?: 'start' | 'restart';
    }): Promise<OldRawSession> {
        if (
            this.kernelConnectionMetadata.kind !== 'startUsingLocalKernelSpec' &&
            this.kernelConnectionMetadata.kind !== 'startUsingPythonInterpreter'
        ) {
            throw new Error(
                `Unable to start Raw Kernels for Kernel Connection of type ${this.kernelConnectionMetadata.kind}`
            );
        }

        this.terminatingStatus = undefined;
        const process = await KernelProgressReporter.wrapAndReportProgress(
            this.resource,
            DataScience.connectingToKernel(getDisplayNameOrNameOfKernelConnection(this.kernelConnectionMetadata)),
            () =>
                this.kernelLauncher.launch(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    this.kernelConnectionMetadata as any,
                    this.launchTimeout,
                    this.resource,
                    this.workingDirectory.fsPath,
                    options.token
                )
        );
        return KernelProgressReporter.wrapAndReportProgress(
            this.resource,
            DataScience.waitingForJupyterSessionToBeIdle,
            () => this.postStartRawSession(options, process)
        );
    }
    private async postStartRawSession(
        options: { token: CancellationToken; ui: IDisplayOptions },
        process: IKernelProcess
    ): Promise<OldRawSession> {
        // Create our raw session, it will own the process lifetime
        const result = new OldRawSession(process, this.resource);

        try {
            // Wait for it to be ready
            traceVerbose('Waiting for Raw Session to be ready in postStartRawSession');
            await raceCancellationError(options.token, result.waitForReady());
            traceVerbose('Successfully waited for Raw Session to be ready in postStartRawSession');
        } catch (ex) {
            traceError('Failed waiting for Raw Session to be ready', ex);
            await process.dispose();
            result.dispose().catch(noop);
            if (isCancellationError(ex) || options.token.isCancellationRequested) {
                throw new CancellationError();
            }
            throw ex;
        }

        // Attempt to get kernel to respond to requests (this is what jupyter does today).
        // Kinda warms up the kernel communication & ensure things are in the right state.
        traceVerbose(`Kernel status before requesting kernel info and after ready is ${result.kernel.status}`);
        // Lets wait for the response (max of 3s), like jupyter (python code) & jupyter client (jupyter lab npm) does.
        // Lets not wait for full timeout, we don't want to slow kernel startup.
        // Note: in node_modules/@jupyterlab/services/lib/kernel/default.js we only wait for 3s.
        // Hence we'll try for a max of 3 seconds (1.5s for first try & then another 1.5s for the second attempt),
        // Note: jupyter (python code) tries this a couple f times).
        // Note: We don't yet want to do what Jupyter does today, it could slow the startup of kernels.
        // Lets try this and see (hence the telemetry to see the cost of this check).
        // We know 10s is way too slow, see https://github.com/microsoft/vscode-jupyter/issues/8917
        const stopWatch = new StopWatch();
        let gotIoPubMessage = createDeferred<boolean>();
        let attempts = 1;
        for (attempts = 1; attempts <= 2; attempts++) {
            gotIoPubMessage = createDeferred<boolean>();
            const iopubHandler = () => gotIoPubMessage.resolve(true);
            result.iopubMessage.connect(iopubHandler);
            try {
                traceVerbose('Sending request for kernelinfo');
                await raceCancellationError(
                    options.token,
                    Promise.all([result.kernel.requestKernelInfo(), gotIoPubMessage.promise]),
                    sleep(Math.min(this.launchTimeout, 1_500)).then(noop)
                );
            } catch (ex) {
                traceError('Failed to request kernel info', ex);
                await process.dispose();
                result.dispose().catch(noop);
                throw ex;
            } finally {
                result.iopubMessage.disconnect(iopubHandler);
            }

            if (gotIoPubMessage.completed) {
                traceVerbose(`Got response for requestKernelInfo`);
                break;
            } else {
                traceVerbose(`Did not get a response for requestKernelInfo`);
                continue;
            }
        }
        if (gotIoPubMessage.completed) {
            traceVerbose('Successfully compelted postStartRawSession');
        } else {
            traceWarning(`Didn't get response for requestKernelInfo after ${stopWatch.elapsedTime}ms.`);
        }
        sendKernelTelemetryEvent(
            this.resource,
            Telemetry.RawKernelInfoResponse,
            { duration: stopWatch.elapsedTime, attempts },
            {
                timedout: !gotIoPubMessage.completed
            }
        );

        /**
         * To get a better understanding of the way Jupyter works, we need to look at Jupyter Client code.
         * Here's an excerpt (there are a lot of checks in a number of different files, this is NOT he only place)
         * Leaving this here for reference purposes.

            def wait_for_ready(self):
                # Wait for kernel info reply on shell channel
                while True:
                    self.kernel_info()
                    try:
                        msg = self.shell_channel.get_msg(block=True, timeout=1)
                    except Empty:
                        pass
                    else:
                        if msg['msg_type'] == 'kernel_info_reply':
                            # Checking that IOPub is connected. If it is not connected, start over.
                            try:
                                self.iopub_channel.get_msg(block=True, timeout=0.2)
                            except Empty:
                                pass
                            else:
                                self._handle_kernel_info_reply(msg)
                                break

                # Flush IOPub channel
                while True:
                    try:
                        msg = self.iopub_channel.get_msg(block=True, timeout=0.2)
                        print(msg['msg_type'])
                    except Empty:
                        break
        */

        return result;
    }
}

/*
RawJupyterSession is the implementation of IJupyterKernelConnectionSession that instead of
connecting to JupyterLab services it instead connects to a kernel directly
through ZMQ.
It's responsible for translating our IJupyterKernelConnectionSession interface into the
jupyterlabs interface as well as starting up and connecting to a raw session
*/
export class RawJupyterSession implements IRawKernelSession, IBaseKernelSession<'localRaw'> {
    public readonly kind = 'localRaw';
    /**
     * Keep a single instance of KernelConnectionWrapper.
     * This way when sessions change, we still have a single Kernel.IKernelConnection proxy (wrapper),
     * which will have all of the event handlers bound to it.
     * This allows consumers to add event handlers hand not worry about internals & can use the lower level Jupyter API.
     */
    private _wrappedKernel?: KernelConnectionWrapper;
    private _isDisposed?: boolean;
    private readonly _disposed = new EventEmitter<void>();
    private readonly didShutdown = new EventEmitter<void>();
    protected readonly disposables: IDisposable[] = [];
    public get disposed() {
        return this._isDisposed === true;
    }
    public get onDidDispose() {
        return this._disposed.event;
    }
    public get onDidShutdown() {
        return this.didShutdown.event;
    }
    protected get session(): RawSession | undefined {
        return this._session;
    }
    public get kernelId(): string {
        return this.session?.kernel?.id || '';
    }
    public get kernel(): Kernel.IKernelConnection | undefined {
        if (this._wrappedKernel) {
            return this._wrappedKernel;
        }
        if (!this._session?.kernel) {
            return;
        }
        this._wrappedKernel = new KernelConnectionWrapper(this._session.kernel, this.disposables);
        return this._wrappedKernel;
    }

    public get kernelSocket(): Observable<KernelSocketInformation | undefined> {
        return this._kernelSocket;
    }
    public get onSessionStatusChanged(): Event<KernelMessage.Status> {
        return this.onStatusChangedEvent.event;
    }

    protected onStatusChangedEvent = new EventEmitter<KernelMessage.Status>();
    protected statusHandler: Slot<RawSession, KernelMessage.Status>;
    protected restartSessionPromise?: { token: CancellationTokenSource; promise: Promise<RawSession> };
    private _session: RawSession | undefined;
    private _kernelSocket = new ReplaySubject<KernelSocketInformation | undefined>();
    private unhandledMessageHandler: Slot<RawSession, KernelMessage.IMessage>;
    private previousAnyMessageHandler?: IDisposable;
    private processExitHandler = new WeakMap<RawSession, IDisposable>();
    private terminatingStatus?: KernelMessage.Status;
    public get atleastOneCellExecutedSuccessfully() {
        if (this.session && this.session instanceof RawSession) {
            return this.session.atleastOneCellExecutedSuccessfully;
        }
        return false;
    }
    public get status(): KernelMessage.Status {
        if (this.terminatingStatus && this.getServerStatus() !== 'dead') {
            return this.terminatingStatus;
        }
        return this.getServerStatus();
    }
    constructor(
        private readonly kernelLauncher: IKernelLauncher,
        private readonly resource: Resource,
        public readonly workingDirectory: Uri,
        private readonly kernelConnectionMetadata: KernelConnectionMetadata,
        private readonly launchTimeout: number
    ) {
        this.statusHandler = this.onStatusChanged.bind(this);
        this.unhandledMessageHandler = (_s, m) => {
            traceWarning(`Unhandled message found: ${m.header.msg_type}`);
        };
    }

    // Connect to the given kernelspec, which should already have ipykernel installed into its interpreter
    public async connect(options: { token: CancellationToken; ui: IDisplayOptions }): Promise<void> {
        // Save the resource that we connect with
        let newSession: RawSession;
        await trackKernelResourceInformation(this.resource, { kernelConnection: this.kernelConnectionMetadata });
        try {
            // Try to start up our raw session, allow for cancellation or timeout
            // Notebook Provider level will handle the thrown error
            newSession = await this.startRawSession({ ...options, purpose: 'start' });
            Cancellation.throwIfCanceled(options.token);
            this.setSession(newSession);

            // Listen for session status changes
            this.session?.statusChanged.connect(this.statusHandler); // NOSONAR
        } catch (error) {
            if (isCancellationError(error) || options.token.isCancellationRequested) {
                traceVerbose('Starting of raw session cancelled by user');
            } else {
                traceError(`Failed to connect raw kernel session: ${error}`);
            }
            throw error;
        }
    }
    public async dispose(): Promise<void> {
        await this.shutdownImplementation();
    }
    public async waitForIdle(timeout: number, token: CancellationToken): Promise<void> {
        if (this.session) {
            return this.waitForIdleOnSession(this.session, timeout, token);
        }
    }

    public async shutdown(): Promise<void> {
        await this.shutdownImplementation();
    }

    public async restart(): Promise<void> {
        // Save old state for shutdown
        const oldSession = this.session;
        const oldStatusHandler = this.statusHandler;

        // TODO? Why aren't we killing this old session here now?
        // We should, If we're restarting and it fails, how is it ok to
        // keep the old session (user could be restarting for a number of reasons).

        // Just switch to the other session. It should already be ready

        // Start the restart session now in case it wasn't started
        const newSession = await this.startRestartSession(false);
        this.setSession(newSession);

        if (newSession.kernel) {
            traceVerbose(`New Session after restarting ${newSession.kernel.id}`);

            // Rewire our status changed event.
            newSession.statusChanged.connect(this.statusHandler);
            newSession.kernel.connectionStatusChanged.connect(this.onKernelConnectionStatusHandler, this);
        }
        if (oldStatusHandler && oldSession) {
            oldSession.statusChanged.disconnect(oldStatusHandler);
            if (oldSession.kernel) {
                oldSession.kernel.connectionStatusChanged.disconnect(this.onKernelConnectionStatusHandler, this);
            }
        }
        traceInfo(`Shutdown old session ${oldSession?.kernel?.id}`);
        this.shutdownSession(oldSession, undefined, false).catch(noop);
    }

    private async shutdownSession(
        session: RawSession | undefined,
        statusHandler: Slot<RawSession, KernelMessage.Status> | undefined,
        isRequestToShutdownRestartSession: boolean | undefined
    ): Promise<void> {
        if (!session) {
            return;
        }
        // Remove our process exit handler. Kernel is shutting down on purpose
        // so we don't need to listen to shutdown anymore.
        this.processExitHandler.get(session)?.dispose();
        // We want to know why we got shut down
        const stacktrace = new Error().stack;
        if (session.kernel) {
            const kernelIdForLogging = `${session.kernel.id}, ${session.kernelConnectionMetadata?.id}`;
            traceVerbose(`shutdownSession ${kernelIdForLogging} - start`);
            try {
                if (statusHandler) {
                    session.statusChanged.disconnect(statusHandler);
                }
                try {
                    traceVerbose(`Session can be shutdown ${session.kernelConnectionMetadata?.id}`);
                    suppressShutdownErrors(session.kernel);
                    // Shutdown may fail if the process has been killed
                    if (!session.isDisposed) {
                        await raceTimeout(1000, session.shutdown());
                    }
                } catch {
                    noop();
                }
                // If session.shutdown didn't work, just dispose
                if (session && !session.isDisposed) {
                    session.dispose().catch(noop);
                }
            } catch (e) {
                // Ignore, just trace.
                traceWarning(e);
            }
            traceVerbose(`shutdownSession ${kernelIdForLogging} - shutdown complete`);
        }

        sendKernelTelemetryEvent(this.resource, Telemetry.RawKernelSessionShutdown, undefined, {
            isRequestToShutdownRestartSession,
            stacktrace
        });
        return session.kernelProcess.dispose();
    }

    protected setSession(session: RawSession | undefined, forceUpdateKernelSocketInfo: boolean = false) {
        if (session) {
            traceInfo(
                `Started Kernel ${getDisplayNameOrNameOfKernelConnection(this.kernelConnectionMetadata)} (pid: ${
                    session.kernelProcess.pid
                })`
            );
        }
        const oldSession = this._session;
        this.previousAnyMessageHandler?.dispose();
        if (session) {
            traceInfo(`Started new session ${session?.kernel?.id}`);
        }
        if (oldSession) {
            if (this.unhandledMessageHandler) {
                oldSession.unhandledMessage.disconnect(this.unhandledMessageHandler);
            }
            if (this.statusHandler) {
                oldSession.statusChanged.disconnect(this.statusHandler);
                oldSession.kernel?.connectionStatusChanged.disconnect(this.onKernelConnectionStatusHandler, this);
            }
        }
        this._session = session;
        if (session) {
            if (session.kernel && this._wrappedKernel) {
                this._wrappedKernel.changeKernel(session.kernel);
            }

            // Listen for session status changes
            session.statusChanged.connect(this.statusHandler);
            session.kernel?.connectionStatusChanged.connect(this.onKernelConnectionStatusHandler, this);
            if (session.kernelSocketInformation.socket?.onAnyMessage) {
                // These messages are sent directly to the kernel bypassing the Jupyter lab npm libraries.
                // As a result, we don't get any notification that messages were sent (on the anymessage signal).
                // To ensure those signals can still be used to monitor such messages, send them via a callback so that we can emit these messages on the anymessage signal.
                this.previousAnyMessageHandler = session.kernelSocketInformation.socket?.onAnyMessage((msg) => {
                    try {
                        if (this._wrappedKernel) {
                            const jupyterLabSerialize =
                                require('@jupyterlab/services/lib/kernel/serialize') as typeof import('@jupyterlab/services/lib/kernel/serialize'); // NOSONAR
                            const message =
                                typeof msg.msg === 'string' || msg.msg instanceof ArrayBuffer
                                    ? jupyterLabSerialize.deserialize(msg.msg)
                                    : msg.msg;
                            this._wrappedKernel.anyMessage.emit({ direction: msg.direction, msg: message });
                        }
                    } catch (ex) {
                        traceWarning(`failed to deserialize message to broadcast anymessage signal`);
                    }
                });
            }
            if (session.unhandledMessage) {
                session.unhandledMessage.connect(this.unhandledMessageHandler);
            }
            // If we have a new session, then emit the new kernel connection information.
            if ((forceUpdateKernelSocketInfo || oldSession !== session) && session.kernel) {
                this._kernelSocket.next({
                    options: {
                        clientId: session.kernel.clientId,
                        id: session.kernel.id,
                        model: { ...session.kernel.model },
                        userName: session.kernel.username
                    },
                    socket: session.kernelSocketInformation.socket
                });
            }
        }
        if (!session) {
            return;
        }
        this.terminatingStatus = undefined;
        // Watch to see if our process exits
        // This is the place to do this, after this session has been setup as the active kernel.
        const disposable = session.kernelProcess.exited(({ exitCode, reason }) => {
            // If this session is no longer the active session, then we don't need to do anything
            // with this exit event (could be we're killing it, or restarting).
            // In the case of restarting, the old session is disposed & a new one created.
            // When disposing the old kernel we shouldn't fire events about session getting terminated.
            if (session !== this.session) {
                return;
            }
            sendKernelTelemetryEvent(
                this.resource,
                Telemetry.RawKernelSessionKernelProcessExited,
                exitCode ? { exitCode } : undefined,
                {
                    exitReason: getTelemetrySafeErrorMessageFromPythonTraceback(reason)
                }
            );
            traceError(`Raw kernel process exited code: ${exitCode}`);

            // If the raw kernel process dies, then send the terminating event, and shutdown the session.
            // Afer shutting down the session, the status changes to `dead`
            this.terminatingStatus = 'terminating';
            this.onStatusChangedEvent.fire('terminating');
            // Shutdown the session but not this class.
            this.setSession(undefined);
            this.shutdownSession(session, this.statusHandler, false)
                .catch((reason) => {
                    traceError(`Error shutting down jupyter session: ${reason}`);
                })
                .finally(() => {
                    // If we're still terminanting this session,
                    // trigger dead status
                    if (this.terminatingStatus) {
                        this.terminatingStatus = 'dead';
                        this.onStatusChangedEvent.fire('dead');
                    }
                });
        });
        this.disposables.push(disposable);
        this.processExitHandler.set(session, disposable);
    }

    protected startRestartSession(disableUI: boolean) {
        const token = new CancellationTokenSource();
        const promise = this.createRestartSession(disableUI, token.token);
        this.restartSessionPromise = { token, promise };
        promise.catch(noop);
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
    private async createRestartSession(disableUI: boolean, cancelToken: CancellationToken): Promise<RawSession> {
        return this.startRawSession({ token: cancelToken, ui: new DisplayOptions(disableUI), purpose: 'restart' });
    }

    private async startRawSession(options: {
        token: CancellationToken;
        ui: IDisplayOptions;
        purpose?: 'start' | 'restart';
    }): Promise<RawSession> {
        if (
            this.kernelConnectionMetadata.kind !== 'startUsingLocalKernelSpec' &&
            this.kernelConnectionMetadata.kind !== 'startUsingPythonInterpreter'
        ) {
            throw new Error(
                `Unable to start Raw Kernels for Kernel Connection of type ${this.kernelConnectionMetadata.kind}`
            );
        }

        this.terminatingStatus = undefined;
        const process = await KernelProgressReporter.wrapAndReportProgress(
            this.resource,
            DataScience.connectingToKernel(getDisplayNameOrNameOfKernelConnection(this.kernelConnectionMetadata)),
            () =>
                this.kernelLauncher.launch(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    this.kernelConnectionMetadata as any,
                    this.launchTimeout,
                    this.resource,
                    this.workingDirectory.fsPath,
                    options.token
                )
        );
        return KernelProgressReporter.wrapAndReportProgress(
            this.resource,
            DataScience.waitingForJupyterSessionToBeIdle,
            () => this.postStartRawSession(options, process)
        );
    }
    private async postStartRawSession(
        options: { token: CancellationToken; ui: IDisplayOptions },
        process: IKernelProcess
    ): Promise<RawSession> {
        // Create our raw session, it will own the process lifetime
        const result = new RawSession(process, this.resource);

        try {
            // Wait for it to be ready
            traceVerbose('Waiting for Raw Session to be ready in postStartRawSession');
            await raceCancellationError(options.token, result.waitForReady());
            traceVerbose('Successfully waited for Raw Session to be ready in postStartRawSession');
        } catch (ex) {
            traceError('Failed waiting for Raw Session to be ready', ex);
            await process.dispose();
            result.dispose().catch(noop);
            if (isCancellationError(ex) || options.token.isCancellationRequested) {
                throw new CancellationError();
            }
            throw ex;
        }

        // Attempt to get kernel to respond to requests (this is what jupyter does today).
        // Kinda warms up the kernel communication & ensure things are in the right state.
        traceVerbose(`Kernel status before requesting kernel info and after ready is ${result.kernel.status}`);
        // Lets wait for the response (max of 3s), like jupyter (python code) & jupyter client (jupyter lab npm) does.
        // Lets not wait for full timeout, we don't want to slow kernel startup.
        // Note: in node_modules/@jupyterlab/services/lib/kernel/default.js we only wait for 3s.
        // Hence we'll try for a max of 3 seconds (1.5s for first try & then another 1.5s for the second attempt),
        // Note: jupyter (python code) tries this a couple f times).
        // Note: We don't yet want to do what Jupyter does today, it could slow the startup of kernels.
        // Lets try this and see (hence the telemetry to see the cost of this check).
        // We know 10s is way too slow, see https://github.com/microsoft/vscode-jupyter/issues/8917
        const stopWatch = new StopWatch();
        let gotIoPubMessage = createDeferred<boolean>();
        let attempts = 1;
        for (attempts = 1; attempts <= 2; attempts++) {
            gotIoPubMessage = createDeferred<boolean>();
            const iopubHandler = () => gotIoPubMessage.resolve(true);
            result.iopubMessage.connect(iopubHandler);
            try {
                traceVerbose('Sending request for kernelinfo');
                await raceCancellationError(
                    options.token,
                    Promise.all([result.kernel.requestKernelInfo(), gotIoPubMessage.promise]),
                    sleep(Math.min(this.launchTimeout, 1_500)).then(noop)
                );
            } catch (ex) {
                traceError('Failed to request kernel info', ex);
                await process.dispose();
                result.dispose().catch(noop);
                throw ex;
            } finally {
                result.iopubMessage.disconnect(iopubHandler);
            }

            if (gotIoPubMessage.completed) {
                traceVerbose(`Got response for requestKernelInfo`);
                break;
            } else {
                traceVerbose(`Did not get a response for requestKernelInfo`);
                continue;
            }
        }
        if (gotIoPubMessage.completed) {
            traceVerbose('Successfully compelted postStartRawSession');
        } else {
            traceWarning(`Didn't get response for requestKernelInfo after ${stopWatch.elapsedTime}ms.`);
        }
        sendKernelTelemetryEvent(
            this.resource,
            Telemetry.RawKernelInfoResponse,
            { duration: stopWatch.elapsedTime, attempts },
            {
                timedout: !gotIoPubMessage.completed
            }
        );

        /**
         * To get a better understanding of the way Jupyter works, we need to look at Jupyter Client code.
         * Here's an excerpt (there are a lot of checks in a number of different files, this is NOT he only place)
         * Leaving this here for reference purposes.

            def wait_for_ready(self):
                # Wait for kernel info reply on shell channel
                while True:
                    self.kernel_info()
                    try:
                        msg = self.shell_channel.get_msg(block=True, timeout=1)
                    except Empty:
                        pass
                    else:
                        if msg['msg_type'] == 'kernel_info_reply':
                            # Checking that IOPub is connected. If it is not connected, start over.
                            try:
                                self.iopub_channel.get_msg(block=True, timeout=0.2)
                            except Empty:
                                pass
                            else:
                                self._handle_kernel_info_reply(msg)
                                break

                # Flush IOPub channel
                while True:
                    try:
                        msg = self.iopub_channel.get_msg(block=True, timeout=0.2)
                        print(msg['msg_type'])
                    except Empty:
                        break
        */

        return result;
    }

    protected async waitForIdleOnSession(
        session: RawSession,
        timeout: number,
        token?: CancellationToken,
        isRestartSession?: boolean
    ): Promise<void> {
        if (session.kernel) {
            try {
                await waitForIdleOnSession(
                    this.kernelConnectionMetadata,
                    this.resource,
                    session,
                    timeout,
                    token,
                    isRestartSession
                );
            } catch (ex) {
                traceInfoIfCI(`Error waiting for idle`, ex);
                this.shutdownSession(session, this.statusHandler, isRestartSession).catch(noop);
                throw ex;
            }
        } else {
            throw new JupyterInvalidKernelError(this.kernelConnectionMetadata);
        }
    }
    private async shutdownImplementation() {
        this._isDisposed = true;
        if (this.session) {
            try {
                traceVerbose(`Shutdown session - current session, called from ${new Error('').stack}`);
                await this.shutdownSession(this.session, this.statusHandler, false);
                traceVerbose('Shutdown session - get restart session');
                if (this.restartSessionPromise) {
                    this.restartSessionPromise.token.cancel();
                    const restartSession = await this.restartSessionPromise.promise;
                    this.restartSessionPromise.token.dispose();
                    traceVerbose('Shutdown session - shutdown restart session');
                    await this.shutdownSession(restartSession, undefined, true);
                }
            } catch {
                noop();
            }
            this.setSession(undefined);
            this.restartSessionPromise = undefined;
            this.onStatusChangedEvent.fire('dead');
            this._disposed.fire();
            this.didShutdown.fire();
            this.didShutdown.dispose();
            this._disposed.dispose();
            this.onStatusChangedEvent.dispose();
            this.previousAnyMessageHandler?.dispose();
        }
        disposeAllDisposables(this.disposables);
        traceVerbose('Shutdown session -- complete');
    }
    private getServerStatus(): KernelMessage.Status {
        if (this.disposed) {
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

    private onKernelConnectionStatusHandler(_: unknown, kernelConnection: Kernel.ConnectionStatus) {
        traceInfoIfCI(`Server Kernel Status = ${kernelConnection}`);
        if (kernelConnection === 'disconnected') {
            const status = this.getServerStatus();
            this.onStatusChangedEvent.fire(status);
        }
    }
    private onStatusChanged(_s: Session.ISessionConnection) {
        const status = this.getServerStatus();
        traceInfoIfCI(`Server Status = ${status}`);
        this.onStatusChangedEvent.fire(status);
    }
}
