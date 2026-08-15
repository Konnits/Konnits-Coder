# Konnits-Coder

A review-first Visual Studio Code frontend for [Qwen Code](https://qwen.ai/qwencode).

Konnits-Coder brings the Qwen Code agent experience into VS Code with a visual workflow focused on agent activity, code review, permissions, Markdown responses, and context visibility.

> [!IMPORTANT]
> Konnits-Coder is **not a model runtime** and does not replace Qwen Code.
>
> You need:
>
> 1. **Qwen Code** running on the computer where you use VS Code.
> 2. A compatible **Qwen model** accessible through a provider supported by Qwen Code.
>
> The model can run on the same computer or on another machine.

---

## How it works

```text
┌─────────────────────────────────┐
│          Your computer          │
│                                 │
│  VS Code                        │
│     ↓                           │
│  Konnits-Coder                  │
│     ↓                           │
│  Qwen Code                      │
│     ↓                           │
└─────┼───────────────────────────┘
      │
      │ OpenAI-compatible API
      ▼
┌─────────────────────────────────┐
│        Inference server         │
│                                 │
│  LM Studio / vLLM / Ollama /    │
│  other compatible provider      │
│     ↓                           │
│  Qwen model                     │
│                                 │
└─────────────────────────────────┘
```

Qwen Code remains responsible for the actual coding-agent behavior:

* understanding the repository;
* reading and searching files;
* reasoning about changes;
* editing code;
* running shell commands;
* running tests;
* handling tools;
* managing agent sessions and context.

Konnits-Coder provides the VS Code interface around that agent.

---

## Features

Konnits-Coder currently provides:

* Qwen Code chat directly inside the VS Code Activity Bar.
* Streaming responses.
* Structured agent activity instead of raw tool-call output.
* Collapsible processing/activity sections.
* Independently collapsible tool calls.
* Safe Markdown rendering.
* Native VS Code diff review.
* Accept/reject workflows for agent-generated changes.
* Interactive permission handling.
* Agent cancellation.
* Session management.
* Context-window usage display.
* Per-message token estimates.
* Qwen-reported turn and context token usage.
* Workspace Trust integration.
* Diagnostics through the `Qwen Frontend` Output channel.
* Support for local and remote OpenAI-compatible model endpoints.

---

# Requirements

## Visual Studio Code

VS Code:

```text
1.125.0 or newer
```

## Node.js

Node.js:

```text
22 or newer
```

Verify it with:

```bash
node --version
```

## Qwen Code

Qwen Code must be installed and working before using Konnits-Coder.

Official website:

https://qwen.ai/qwencode

Official documentation:

https://qwenlm.github.io/qwen-code-docs/

## Model endpoint

You also need a model available through a provider understood by Qwen Code.

This project is primarily designed around **Qwen models** served through an OpenAI-compatible endpoint.

For example:

```text
Qwen model
     ↓
LM Studio
     ↓
http://localhost:1234/v1
```

The endpoint may be local or remote.

---

# 1. Install Qwen Code

Qwen Code provides standalone installers.

## Windows

Open PowerShell:

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

Restart the terminal afterward.

## Linux / macOS

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

Alternatively, if you already have Node.js 22+:

```bash
npm install -g @qwen-code/qwen-code@latest
```

Verify the installation:

```bash
qwen --version
```

Then start Qwen Code once:

```bash
qwen
```

If Qwen Code itself cannot run successfully, configure it before trying Konnits-Coder.

---

# 2. Serve a Qwen model

Konnits-Coder does not care where inference happens.

The important part is that **Qwen Code can reach the model provider**.

A common configuration is LM Studio.

---

## LM Studio — same computer

Load your Qwen model in LM Studio and start its API server.

The default OpenAI-compatible endpoint is commonly:

```text
http://localhost:1234/v1
```

You can verify the server with:

```powershell
curl.exe http://localhost:1234/v1/models
```

The response should contain the IDs of the models available through LM Studio.

For example:

```json
{
  "data": [
    {
      "id": "qwen3.6-35b-a3b"
    }
  ]
}
```

Use the **exact model ID returned by the server** when configuring Qwen Code.

---

## LM Studio with authentication

LM Studio can require API-token authentication.

If authentication is enabled, create a token from:

```text
LM Studio
→ Developer
→ Server Settings
→ Manage Tokens
```

Then test it from PowerShell:

```powershell
$env:LM_API_TOKEN = "YOUR_TOKEN"

curl.exe `
  -H "Authorization: Bearer $env:LM_API_TOKEN" `
  http://localhost:1234/v1/models
```

Do not commit API tokens to Git.

---

# 3. Configure Qwen Code

There are two ways to configure the model.

## Option A — Qwen Code configuration wizard

Start:

```bash
qwen
```

Then run:

```text
/auth
```

Choose a custom/OpenAI-compatible provider and configure your endpoint, model and credentials.

You can inspect or switch configured models using:

```text
/model
```

You can also diagnose your Qwen installation with:

```text
/doctor
```

---

## Option B — configure `settings.json` manually

Qwen Code user settings are stored at:

```text
~/.qwen/settings.json
```

On Windows, `~` refers to your user profile directory.

For example:

```text
C:\Users\your-user\.qwen\settings.json
```

A configuration for a Qwen model running in LM Studio could look like this:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-35b-a3b",
        "name": "Qwen 3.6 - LM Studio",
        "baseUrl": "http://localhost:1234/v1",
        "envKey": "LMSTUDIO_API_KEY",
        "generationConfig": {
          "timeout": 300000,
          "maxRetries": 2,
          "contextWindowSize": 262144,
          "extra_body": {
            "enable_thinking": true
          }
        }
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.6-35b-a3b"
  }
}
```

> [!IMPORTANT]
> Replace `qwen3.6-35b-a3b` with the actual model ID returned by your inference server.
>
> Also configure `contextWindowSize` according to the context size actually supported/configured by your model server.
>
> Do not blindly copy `262144` for every model.

`enable_thinking` should only be enabled when supported by the model/provider combination you are using.

---

# 4. Configure the API token

The recommended place for provider credentials is:

```text
~/.qwen/.env
```

For LM Studio:

```env
LMSTUDIO_API_KEY=YOUR_LM_STUDIO_TOKEN
```

Your `settings.json` then references the variable:

```json
"envKey": "LMSTUDIO_API_KEY"
```

This keeps the secret separate from the model configuration.

> [!WARNING]
> Never commit `.env` files containing API tokens.

If your local model server does not require authentication, a placeholder value can be used where required by the OpenAI-compatible provider configuration:

```env
LMSTUDIO_API_KEY=lm-studio
```

---

# 5. Test Qwen Code before installing Konnits-Coder

This step is strongly recommended.

Open a terminal inside any repository:

```bash
cd /path/to/project
qwen
```

Try:

```text
Explain briefly what this repository does. Do not modify any files.
```

Confirm that Qwen Code can:

* connect to your model;
* answer normally;
* read files;
* invoke tools;
* access the repository.

If this does not work directly in Qwen Code, Konnits-Coder will not be able to fix the underlying provider configuration.

---

# 6. Install Konnits-Coder

Konnits-Coder can currently be installed from a `.vsix` package.

In VS Code:

```text
Extensions
→ ...
→ Install from VSIX...
```

Select the downloaded `.vsix` file.

Alternatively, from a terminal:

```bash
code --install-extension path/to/qwen-frontend-0.1.0.vsix
```

To reinstall or upgrade an existing local build:

```bash
code --install-extension path/to/qwen-frontend-0.1.0.vsix --force
```

Then reload VS Code:

```text
Ctrl + Shift + P
→ Developer: Reload Window
```

---

# 7. Open Konnits-Coder

Open a project or repository in VS Code.

You should see the **Qwen** icon in the Activity Bar.

Open it to access the chat.

A good first test is:

```text
Analyze this repository and briefly describe its architecture.
Do not modify any files.
```

You should see Qwen activity appear in the Processing section followed by the final response.

---

# Using a remote model

One of the main use cases for Konnits-Coder is running VS Code on one computer while inference happens on a more powerful machine.

For example:

```text
Laptop / workstation
──────────────────────────────────
VS Code
Konnits-Coder
Qwen Code
Project files
Qwen tools
       │
       │ network
       ▼
GPU server
──────────────────────────────────
LM Studio
RTX GPU
Qwen model
```

The important distinction is:

```text
Qwen Code + tools = client computer
Model inference   = server computer
```

File reads, shell commands, tests and other Qwen Code tools execute on the computer where VS Code/Qwen Code is running.

However, **model context can contain repository content and tool results**, so relevant project information will be transmitted to the configured inference endpoint.

Only use endpoints you trust with your source code.

---

## Remote LM Studio on the same LAN

On the GPU computer, enable:

```text
LM Studio
→ Developer
→ Server Settings
→ Serve on Local Network
```

Or use the LM Studio CLI:

```bash
lms server start --bind 0.0.0.0
```

Suppose the GPU computer has IP:

```text
192.168.1.50
```

The Qwen Code configuration on your VS Code computer would use:

```json
"baseUrl": "http://192.168.1.50:1234/v1"
```

Example:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-35b-a3b",
        "name": "Qwen 3.6 - Remote GPU",
        "baseUrl": "http://192.168.1.50:1234/v1",
        "envKey": "LMSTUDIO_REMOTE_API_KEY",
        "generationConfig": {
          "timeout": 300000,
          "contextWindowSize": 262144,
          "extra_body": {
            "enable_thinking": true
          }
        }
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.6-35b-a3b"
  }
}
```

And:

```text
~/.qwen/.env
```

could contain:

```env
LMSTUDIO_REMOTE_API_KEY=YOUR_REMOTE_LM_STUDIO_TOKEN
```

---

# Network security

If LM Studio is exposed beyond `localhost`, enable authentication.

Do **not** expose an unauthenticated LM Studio server directly to the public Internet.

For access outside your local network, prefer a secure solution such as:

```text
VPN
private network
encrypted tunnel
HTTPS reverse proxy
```

The model endpoint may receive source code, prompts, tool results and other repository context.

Treat access to the inference server accordingly.

---

# Using other inference servers

LM Studio is only one option.

Qwen Code supports OpenAI-compatible providers, so a Qwen model may also be served through software such as:

```text
vLLM
Ollama
SGLang
compatible cloud/provider APIs
custom OpenAI-compatible gateways
```

Your Qwen configuration simply needs to point to the appropriate endpoint:

```json
{
  "id": "YOUR_MODEL_ID",
  "baseUrl": "http://YOUR_SERVER/v1",
  "envKey": "YOUR_API_KEY_VARIABLE"
}
```

The endpoint must implement the API behavior required by Qwen Code, including the model/tool-calling capabilities needed for agent workflows.

---

# Multiple models

Qwen Code supports multiple configured model providers.

For example:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-35b-a3b",
        "name": "Qwen - Local",
        "baseUrl": "http://localhost:1234/v1",
        "envKey": "LMSTUDIO_LOCAL_API_KEY"
      },
      {
        "id": "qwen3.6-35b-a3b",
        "name": "Qwen - Remote GPU",
        "baseUrl": "http://192.168.1.50:1234/v1",
        "envKey": "LMSTUDIO_REMOTE_API_KEY"
      }
    ]
  }
}
```

The same model ID can be configured against different endpoints.

Qwen Code distinguishes provider-model entries using the combination of model ID and Base URL.

---

# Troubleshooting

## `qwen` is not recognized

Verify:

```bash
qwen --version
```

If you just installed Qwen Code, restart the terminal.

If necessary, reinstall it.

With npm:

```bash
npm install -g @qwen-code/qwen-code@latest
```

---

## Node.js is too old

Check:

```bash
node --version
```

Use Node.js 22 or newer.

---

## Konnits-Coder opens but Qwen does not respond

First test Qwen directly:

```bash
qwen
```

Then use:

```text
/doctor
```

If direct Qwen Code does not work, fix that configuration first.

Inside VS Code you can also open:

```text
View
→ Output
→ Qwen Frontend
```

for extension diagnostics.

---

## HTTP 401 / Unauthorized

Your provider requires authentication.

For LM Studio, verify that the API token referenced by:

```json
"envKey": "LMSTUDIO_API_KEY"
```

exists in:

```text
~/.qwen/.env
```

or in your environment.

---

## Connection refused

Verify:

* the model server is running;
* the Base URL is correct;
* the port is correct;
* the firewall allows the connection;
* remote serving is enabled if using another computer.

For LM Studio:

```text
http://HOST:1234/v1/models
```

should be reachable from the Qwen Code computer.

---

## Model not found

Check the model IDs exposed by the server:

```powershell
curl.exe http://localhost:1234/v1/models
```

Use the exact returned ID in:

```json
"id": "..."
```

---

## Remote LM Studio works locally but not from another computer

Make sure **Serve on Local Network** is enabled.

Also check the operating-system firewall.

From the client computer, test:

```text
http://SERVER_IP:1234/v1/models
```

---

## Qwen answers but does not use tools correctly

The model and inference server must correctly support the tool/function-calling behavior required by Qwen Code.

Use a Qwen model suitable for agentic/coding workflows and verify the same prompt directly through the Qwen Code CLI.

---

## Context usage looks incorrect

Check the effective model configuration:

```json
"generationConfig": {
  "contextWindowSize": ...
}
```

This value should match the context configuration supported by the model/server.

---

# Updating Konnits-Coder

When installing another `.vsix` build:

```bash
code --install-extension path/to/new-version.vsix --force
```

Then:

```text
Developer: Reload Window
```

---

# Building from source

Clone the repository and install dependencies:

```bash
npm install
```

Run the complete validation suite:

```bash
npm run check
```

Create a production build:

```bash
npm run build
```

To package the extension as a VSIX, install Microsoft's VS Code Extension packaging tool:

```bash
npm install -g @vscode/vsce
```

Then:

```bash
vsce package
```

If the repository metadata has not yet been configured:

```bash
vsce package --allow-missing-repository
```

Install the resulting package:

```bash
code --install-extension ./qwen-frontend-0.1.0.vsix
```

---

# Privacy

Konnits-Coder itself does not provide a model hosting service.

Qwen Code sends model requests to the provider you configure.

Depending on the task, those requests may contain:

* your prompts;
* source-code excerpts;
* file contents;
* tool results;
* repository metadata;
* conversation context.

If you use a remote inference server, make sure you trust that server and the network path used to reach it.

---

# Recommended setup

For a fully local development setup:

```text
Same computer
├── VS Code
├── Konnits-Coder
├── Qwen Code
├── LM Studio
└── Qwen model
```

For a workstation + GPU server setup:

```text
Development computer
├── VS Code
├── Konnits-Coder
├── Qwen Code
└── Repository
        │
        │ authenticated API
        ▼
GPU computer
├── LM Studio
├── NVIDIA GPU
└── Qwen model
```

The second configuration allows a lightweight computer to use the GPU resources of another machine while Qwen Code continues operating on the local repository.

---

# Official resources

Qwen Code:

https://qwen.ai/qwencode

Qwen Code documentation:

https://qwenlm.github.io/qwen-code-docs/

Qwen Code quickstart:

https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/

Qwen Code model providers:

https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/

Qwen Code authentication:

https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/

LM Studio documentation:

https://lmstudio.ai/docs/

LM Studio OpenAI-compatible API:

https://lmstudio.ai/docs/developer/openai-compat

LM Studio network serving:

https://lmstudio.ai/docs/developer/core/server/serve-on-network

LM Studio API authentication:

https://lmstudio.ai/docs/developer/core/authentication

---

# Disclaimer

Konnits-Coder is an independent project and is not an official Qwen Code extension.

Qwen, Qwen Code, Visual Studio Code, LM Studio and other referenced products belong to their respective owners.

Compatibility may change as Qwen Code, VS Code and model-provider APIs evolve.

---

# License

Licensed under the Apache License 2.0.

See `LICENSE` for details.
