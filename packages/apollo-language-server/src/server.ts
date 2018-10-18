import { dirname } from "path";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  FileChangeType
} from "vscode-languageserver";
import { QuickPickItem } from "vscode";
import Uri from "vscode-uri";
import { findAndLoadConfig } from "apollo/lib/config";
import { GraphQLWorkspace } from "./workspace";
import { GraphQLLanguageProvider } from "./languageProvider";
import { LoadingHandler } from "./loadingHandler";

const connection = createConnection(ProposedFeatures.all);

let hasWorkspaceFolderCapability = false;

const workspace = new GraphQLWorkspace(new LoadingHandler(connection));

workspace.onSchemaTags((tags: Map<string, string[]>) => {
  connection.sendNotification(
    "apollographql/tagsLoaded",
    JSON.stringify([...tags])
  );
});

workspace.onDiagnostics(params => {
  connection.sendDiagnostics(params);
});

workspace.onDecorations(decs => {
  connection.sendNotification("apollographql/engineDecorations", decs);
});

let initialize: () => void;
const whenInitialized = new Promise<void>(resolve => (initialize = resolve));

connection.onInitialized(async () => {
  initialize();

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(event => {
      event.removed.forEach(folder => workspace.removeProjectsInFolder(folder));
      event.added.forEach(folder => workspace.addProjectsInFolder(folder));
    });
  }
});

connection.onInitialize(async params => {
  let capabilities = params.capabilities;
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && capabilities.workspace.workspaceFolders
  );

  const workspaceFolders = params.workspaceFolders;
  if (workspaceFolders) {
    whenInitialized.then(() => {
      workspaceFolders.forEach(folder => workspace.addProjectsInFolder(folder));
    });
  }

  return {
    capabilities: {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["..."]
      },
      codeLensProvider: {
        resolveProvider: false
      },
      textDocumentSync: documents.syncKind
    }
  };
});

const documents: TextDocuments = new TextDocuments();

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

documents.onDidChangeContent(params => {
  const project = workspace.projectForFile(params.document.uri);
  if (!project) return;

  project.documentDidChange(params.document);
});

connection.onDidChangeWatchedFiles(params => {
  for (const change of params.changes) {
    const uri = change.uri;

    const filePath = Uri.parse(change.uri).fsPath;
    if (
      filePath.endsWith("apollo.config.js") ||
      filePath.endsWith("package.json")
    ) {
      const projectForConfig = Array.from(
        workspace.projectsByFolderUri.values()
      )
        .flatMap(arr => arr)
        .find(proj => {
          return proj.configFile === filePath;
        });

      if (projectForConfig) {
        const newConfig = findAndLoadConfig(
          dirname(projectForConfig.configFile),
          false,
          true
        );

        if (newConfig) {
          projectForConfig.updateConfig(newConfig);
        }
      }
    }

    // Don't respond to changes in files that are currently open,
    // because we'll get content change notifications instead
    if (change.type === FileChangeType.Changed) {
      continue;
    }

    const project = workspace.projectForFile(uri);
    if (!project) continue;

    switch (change.type) {
      case FileChangeType.Created:
        project.fileDidChange(uri);
        break;
      case FileChangeType.Deleted:
        project.fileWasDeleted(uri);
        break;
    }
  }
});

const languageProvider = new GraphQLLanguageProvider(workspace);

connection.onHover((params, token) =>
  languageProvider.provideHover(params.textDocument.uri, params.position, token)
);

connection.onDefinition((params, token) =>
  languageProvider.provideDefinition(
    params.textDocument.uri,
    params.position,
    token
  )
);

connection.onReferences((params, token) =>
  languageProvider.provideReferences(
    params.textDocument.uri,
    params.position,
    params.context,
    token
  )
);

connection.onCompletion((params, token) =>
  languageProvider.provideCompletionItems(
    params.textDocument.uri,
    params.position,
    token
  )
);

connection.onCodeLens((params, token) =>
  languageProvider.provideCodeLenses(params.textDocument.uri, token)
);

connection.onNotification(
  "apollographql/tagSelected",
  (selection: QuickPickItem) => workspace.updateSchemaTag(selection)
);

connection.listen();
