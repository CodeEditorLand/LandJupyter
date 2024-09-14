// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import './progress.css';

import * as React from 'react';

export class Progress extends React.Component {
    public override render() {
        // Vscode does this with two parts, a progress container and a progress bit
        return (
            <div className="monaco-progress-container active infinite">
                <div className="progress-bit" />
            </div>
        );
    }
}
