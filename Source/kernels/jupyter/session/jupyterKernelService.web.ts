// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable } from "inversify";
import { CancellationToken } from "vscode";

import { IDisplayOptions, Resource } from "../../../platform/common/types";
import { ignoreLogging, logger, logValue } from "../../../platform/logging";
import { KernelConnectionMetadata } from "../../types";
import { IJupyterKernelService } from "../types";

/**
 * Responsible for registering and updating kernels in a web situation
 *
 * @export
 * @class JupyterKernelService
 */
@injectable()
export class JupyterKernelService implements IJupyterKernelService {
	/**
	 * Makes sure that the kernel pointed to is a valid jupyter kernel (it registers it) and
	 * that is up to date relative to the interpreter that it might contain
	 * @param resource
	 * @param kernel
	 */
	public async ensureKernelIsUsable(
		_resource: Resource,
		@logValue<KernelConnectionMetadata>("id")
		_kernel: KernelConnectionMetadata,
		@logValue<IDisplayOptions>("disableUI") _ui: IDisplayOptions,
		@ignoreLogging() _cancelToken: CancellationToken,
		_cannotChangeKernels?: boolean,
	): Promise<void> {
		logger.debug("Check if a kernel is usable");
		// For now web kernels are always usable.
	}
}
