import * as vscode from 'vscode';

export type WireToolDefinition = Record<string, unknown>;

/**
 * OpenCode's free tier and Zen gateway strictly verify that callers originate
 * from within the official OpenCode client by requiring core client tools
 * (`bash` and `read`) to be present in the request payload.
 */
export const OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES = [
  {
    type: 'function',
    name: 'bash',
    description: 'OpenCode client environment verification tool. Do not call this tool directly.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'read',
    description: 'OpenCode client environment verification tool. Do not call this tool directly.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
];

export const OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'OpenCode client environment verification tool. Do not call this tool directly.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'OpenCode client environment verification tool. Do not call this tool directly.',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
];

export function injectOpenCodeVerificationTools(
  toolsPayload: WireToolDefinition[] | undefined,
  isResponses: boolean
): WireToolDefinition[] {
  const base = toolsPayload ?? [];
  if (isResponses) {
    const existing = new Set(base.map((t) => (typeof t.name === 'string' ? t.name : '')));
    const toAdd = OPENCODE_CLIENT_VERIFICATION_TOOLS_RESPONSES.filter((t) => !existing.has(t.name));
    return toAdd.length > 0 ? [...base, ...toAdd] : base;
  }
  const existing = new Set(
    base.map((t) => {
      const fn = t.function;
      if (typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string') {
        return fn.name;
      }
      return '';
    })
  );
  const toAdd = OPENCODE_CLIENT_VERIFICATION_TOOLS_CHAT.filter((t) => !existing.has(t.function.name));
  return toAdd.length > 0 ? [...base, ...toAdd] : base;
}

function clampToolName(name: string): string {
  return name.length > 64 ? name.slice(0, 64) : name;
}

export function formatProviderTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  isResponses: boolean,
  injectVerificationTools: boolean
): WireToolDefinition[] | undefined {
  let toolsPayload: WireToolDefinition[] | undefined;
  if (tools && tools.length > 0) {
    if (isResponses) {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        name: clampToolName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      }));
    } else {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        function: {
          name: clampToolName(tool.name),
          description: tool.description,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }
  }

  return injectVerificationTools
    ? injectOpenCodeVerificationTools(toolsPayload, isResponses)
    : toolsPayload;
}

export function isSyntheticVerificationTool(
  toolName: string,
  callerTools: readonly vscode.LanguageModelChatTool[] | undefined
): boolean {
  if (toolName !== 'bash' && toolName !== 'read') {
    return false;
  }
  if (!callerTools || callerTools.length === 0) {
    return true;
  }
  return !callerTools.some((tool) => clampToolName(tool.name) === toolName);
}
