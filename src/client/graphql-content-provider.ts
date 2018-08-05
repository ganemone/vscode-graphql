import {
  workspace,
  OutputChannel,
  TextDocumentContentProvider,
  EventEmitter,
  Uri,
  Event,
  ProviderResult,
  window
} from "vscode";

import { ExtractedTemplateLiteral } from "./source-helper";
import {
  GraphQLConfig,
  getGraphQLConfig,
  GraphQLProjectConfig
} from "graphql-config";
import { visit, VariableDefinitionNode } from "graphql";
import { NetworkHelper } from "./network-helper";
import { SourceHelper, GraphQLScalarTSType } from "./source-helper";

export class GraphQLContentProvider implements TextDocumentContentProvider {
  private uri: Uri;
  private outputChannel: OutputChannel;
  private networkHelper: NetworkHelper;
  private sourceHelper: SourceHelper;

  // Event emitter which invokes document updates
  private _onDidChange = new EventEmitter<Uri>();

  private html: string = ""; // HTML document buffer

  async getVariablesFromUser(
    variableDefinitionNodes: VariableDefinitionNode[]
  ): Promise<{ [key: string]: GraphQLScalarTSType }> {
    let variables = {};
    for (let node of variableDefinitionNodes) {
      variables = {
        ...variables,
        [`${node.variable.name.value}`]: this.sourceHelper.typeCast(
          await window.showInputBox({
            ignoreFocusOut: true,
            placeHolder: `Please enter the value for ${
              node.variable.name.value
            }`
          }),
          this.sourceHelper.getTypeForVariableDefinitionNode(node)
        )
      };
    }
    return variables;
  }

  /*
    Use the configration of first project if heuristics failed 
    to find one.
  */
  patchProjectConfig(config: GraphQLConfig) {
    if (!config.config.projects) {
      return config;
    }
    if (config.config.projects) {
      const projectKeys = Object.keys(config.config.projects);
      return config.getProjectConfig(projectKeys[0]);
    }
    return null;
  }

  constructor(
    uri: Uri,
    outputChannel: OutputChannel,
    literal: ExtractedTemplateLiteral
  ) {
    this.uri = uri;
    this.outputChannel = outputChannel;
    this.networkHelper = new NetworkHelper(this.outputChannel);
    this.sourceHelper = new SourceHelper(this.outputChannel);

    try {
      const rootDir = workspace.getWorkspaceFolder(Uri.file(literal.uri));
      if (!rootDir) {
        this.outputChannel.appendLine(
          `Error: this file is outside the workspace.`
        );
        this.html = "Error: this file is outside the workspace.";
        this.update(this.uri);
        return;
      } else {
        const config = getGraphQLConfig(rootDir!.uri.fsPath);
        let projectConfig = config.getConfigForFile(literal.uri);
        if (!projectConfig) {
          projectConfig = this.patchProjectConfig(
            config
          ) as GraphQLProjectConfig;
        }

        if (!projectConfig!.endpointsExtension) {
          this.outputChannel.appendLine(
            `Error: endpoint data missing from graphql config`
          );
          this.html = "Error: endpoint data missing from graphql config";
          this.update(this.uri);
          return;
        }

        const endpointNames = Object.keys(
          projectConfig!.endpointsExtension!.getRawEndpointsMap()
        );

        if (endpointNames.length === 0) {
          this.outputChannel.appendLine(
            `Error: endpoint data missing from graphql config endpoints extension`
          );
          this.html =
            "Error: endpoint data missing from graphql config endpoints extension";
          this.update(this.uri);
          return;
        }

        // TODO: Can ask user for the endpoint if muliple exist
        // Endpoints extensions docs say that at least "default" will be there
        const endpointName = endpointNames[0];
        const endpoint = projectConfig!.endpointsExtension!.getEndpoint(
          endpointName
        );

        let variableDefinitionNodes: VariableDefinitionNode[] = [];
        visit(literal.ast, {
          VariableDefinition(node: VariableDefinitionNode) {
            variableDefinitionNodes.push(node);
          }
        });

        const updateCallback = (data: string, operation: string) => {
          if (operation === "subscription") {
            this.html = `<pre>${data}</pre>` + this.html;
          } else {
            this.html += `<pre>${data}</pre>`;
          }
          this.update(this.uri);
        };

        if (variableDefinitionNodes.length > 0) {
          this.getVariablesFromUser(variableDefinitionNodes).then(
            (variables: any) => {
              this.networkHelper.executeOperation({
                endpoint: endpoint,
                literal: literal,
                variables: variables,
                updateCallback
              });
            }
          );
        } else {
          this.networkHelper.executeOperation({
            endpoint: endpoint,
            literal: literal,
            variables: {},
            updateCallback
          });
        }
      }
    } catch (e) {
      this.html = e.toString();
    }
  }

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event;
  }

  public update(uri: Uri) {
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(_: Uri): ProviderResult<string> {
    return this.html;
  }
}
