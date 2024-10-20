// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Environment } from "@vscode/python-extension";

import { Product } from "../interpreter/installer/types";
import { PythonEnvironment } from "../pythonEnvironments/info";
import { BaseError } from "./types";

/**
 * Thrown when we fail to install a Package due to long path not being enabled on Windows. */
export class PackageNotInstalledWindowsLongPathNotEnabledError extends BaseError {
	constructor(
		public readonly product: Product | string,
		public readonly interpreter: PythonEnvironment | Environment,
		public readonly originalMessage: string,
	) {
		super("windowsLongPathNotEnabled", originalMessage);
	}
}
