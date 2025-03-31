// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Environment } from "@vscode/python-extension";
import { NotebookDocument, NotebookEditor, Uri, type Event } from "vscode";

import { Resource } from "../platform/common/types";

export interface IEmbedNotebookEditorProvider {
	findNotebookEditor(resource: Resource): NotebookEditor | undefined;
	findAssociatedNotebookDocument(uri: Uri): NotebookDocument | undefined;
}

export const INotebookEditorProvider = Symbol("INotebookEditorProvider");
export interface INotebookEditorProvider {
	activeNotebookEditor: NotebookEditor | undefined;
	findNotebookEditor(resource: Resource): NotebookEditor | undefined;
	findAssociatedNotebookDocument(uri: Uri): NotebookDocument | undefined;
	registerEmbedNotebookProvider(provider: IEmbedNotebookEditorProvider): void;
}

export const INotebookPythonEnvironmentService = Symbol(
	"INotebookPythonEnvironmentService",
);
export interface INotebookPythonEnvironmentService {
	onDidChangeEnvironment: Event<Uri>;
	getPythonEnvironment(uri: Uri): Environment | undefined;
}
