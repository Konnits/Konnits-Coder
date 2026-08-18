import * as vscode from "vscode";
import {
  DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
  type QwenClientConfiguration,
} from "../qwen/QwenCodeAgentClient.js";
import { parseConfigurationValues } from "./ConfigurationValues.js";

export class Configuration {
  getQwenClientConfiguration(): QwenClientConfiguration {
    const configuration = vscode.workspace.getConfiguration("qwenFrontend");
    return parseConfigurationValues(
      configuration.get<string>("qwen.executablePath", ""),
      configuration.get<boolean>("debug", false),
      configuration.get<boolean>("qwen.allowImageInput", false),
      configuration.get<number>(
        "qwen.streamIdleTimeoutMs",
        DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
      ),
      configuration.get<string>("qwen.permissionMode", "default"),
    );
  }
}
