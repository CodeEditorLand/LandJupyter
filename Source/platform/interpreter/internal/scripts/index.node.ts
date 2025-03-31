// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EXTENSION_ROOT_DIR } from "../../../constants.node";
import * as path from "../../../vscode-path/path";

// It is simpler to hard-code it instead of using vscode.ExtensionContext.extensionPath.
export const _SCRIPTS_DIR = path.join(EXTENSION_ROOT_DIR, "pythonFiles");
