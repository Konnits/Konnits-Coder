import * as vscode from "vscode";
import type { QwenClientConfiguration } from "../qwen/QwenCodeAgentClient.js";
import { parseConfigurationValues } from "./ConfigurationValues.js";

export class Configuration {
  getQwenClientConfiguration(): QwenClientConfiguration {
    const configuration = vscode.workspace.getConfiguration("qwenFrontend");
    return parseConfigurationValues(
      configuration.get<string>("qwen.executablePath", ""),
      configuration.get<boolean>("debug", false),
    );
  }
}
