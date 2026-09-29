// Chat infrastructure: tool definition mapping and verification tools.
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

// OpenCode's gateway validates every tool JSON Schema we send and rejects the whole
// request with `a single enum property with more than 250 values exceeds the maximum
// combined enum string length of 15000 characters`. One offending property in one tool
// fails every request in the session, so oversized enums are dropped here rather than
// forwarded. Values sit 20% under the gateway's documented ceiling for headroom against
// undocumented upstream drift.
const OPENCODE_MAX_ENUM_VALUES = 200;
const OPENCODE_MAX_ENUM_CHARS = 12000;

// Keys whose values are data, not schema — EXCEPT when the containing node is
// a map of named schemas, where each value is itself a schema regardless of
// its key. See NAMED_SCHEMA_MAPS.
const NON_SCHEMA_DATA_KEYS = new Set([
  'enum',
  'const',
  'default',
  'example',
  'examples',
  'description',
  'title',
  '$comment',
]);

// Objects whose entries are named schemas, keyed by arbitrary names a tool
// author chooses. Under these nodes, keys like `enum`, `default`, or
// `examples` are property/definition names — not keywords — and their values
// must always be visited, or an oversized enum under e.g.
// `properties: { enum: { enum: [...] } }` still reaches the gateway and 400s
// the whole request.
const NAMED_SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

function exceedsEnumLimits(values: unknown[]): boolean {
  if (values.length > OPENCODE_MAX_ENUM_VALUES) return true;
  let total = 0;
  for (const value of values) {
    total += String(value).length;
    if (total > OPENCODE_MAX_ENUM_CHARS) return true;
  }
  return false;
}

interface DropResult {
  node: unknown;
  changed: boolean;
}

function shouldDropEnum(value: unknown): value is unknown[] {
  return Array.isArray(value) && exceedsEnumLimits(value);
}

function stripArrayItems(
  items: unknown[],
  path: string,
  onDrop: (path: string, count: number) => void,
  inProgress: Set<unknown>
): DropResult {
  if (inProgress.has(items)) return { node: items, changed: false };
  inProgress.add(items);
  let changed = false;
  const out: unknown[] = [];
  for (const item of items) {
    const result = stripOversizedEnums(item, path, onDrop, inProgress);
    if (result.changed) changed = true;
    out.push(result.node);
  }
  inProgress.delete(items);
  return { node: out, changed };
}

interface EntryResult {
  value: unknown;
  changed: boolean;
  dropped: boolean;
}

function stripMapEntries(
  entries: Record<string, unknown>,
  path: string,
  onDrop: (path: string, count: number) => void,
  inProgress: Set<unknown>
): { out: Record<string, unknown>; changed: boolean } {
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [name, subschema] of Object.entries(entries)) {
    const result = stripOversizedEnums(subschema, `${path}.${name}`, onDrop, inProgress);
    if (result.changed) changed = true;
    out[name] = result.node;
  }
  return { out, changed };
}

function stripEntry(
  key: string,
  value: unknown,
  childPath: string,
  parentPath: string,
  onDrop: (path: string, count: number) => void,
  inProgress: Set<unknown>
): EntryResult {
  if (key === 'enum') {
    if (shouldDropEnum(value)) {
      onDrop(parentPath, value.length);
      return { value: undefined, changed: true, dropped: true };
    }
    return { value, changed: false, dropped: false };
  }
  if (typeof value === 'object' && value !== null && NAMED_SCHEMA_MAPS.has(key)) {
    // A map of named schemas: every value is a subschema, keyed by an author-
    // chosen name that may collide with a keyword.
    const result = stripMapEntries(value as Record<string, unknown>, childPath, onDrop, inProgress);
    return { value: result.out, changed: result.changed, dropped: false };
  }
  if (NON_SCHEMA_DATA_KEYS.has(key)) {
    return { value, changed: false, dropped: false };
  }
  const result = stripOversizedEnums(value, childPath, onDrop, inProgress);
  return { value: result.node, changed: result.changed, dropped: false };
}

function needsStringType(droppedOwnEnum: boolean, droppedValues: unknown[], out: Record<string, unknown>): boolean {
  // Impose a string type only when the dropped enum constrained to strings:
  // a numeric enum ({ enum: [0..300] }) left typeless keeps every numeric
  // argument valid, while type: 'string' would invalidate all of them.
  return (
    droppedOwnEnum &&
    !('type' in out) &&
    !('$ref' in out) &&
    droppedValues.length > 0 &&
    droppedValues.every((value) => typeof value === 'string')
  );
}

function stripObjectSchema(
  source: Record<string, unknown>,
  path: string,
  onDrop: (path: string, count: number) => void,
  inProgress: Set<unknown>
): DropResult {
  if (inProgress.has(source)) return { node: source, changed: false };
  inProgress.add(source);
  const out: Record<string, unknown> = {};
  let changed = false;
  let droppedValues: unknown[] | undefined;

  for (const [key, value] of Object.entries(source)) {
    const entry = stripEntry(key, value, `${path}.${key}`, path, onDrop, inProgress);
    if (entry.dropped) {
      changed = true;
      droppedValues = Array.isArray(value) ? value : [];
      continue;
    }
    if (entry.changed) changed = true;
    out[key] = entry.value;
  }

  // A node whose own enum was its only shape information now constrains and describes
  // nothing; a free-form string keeps it usable. Keyed on this node's own drop, not on
  // `changed`, which also propagates from descendants.
  if (needsStringType(droppedValues !== undefined, droppedValues ?? [], out)) {
    out.type = 'string';
  }

  inProgress.delete(source);
  return { node: out, changed };
}

/**
 * Rebuilds a schema with oversized enums removed, descending generically through every
 * object and array except `NON_SCHEMA_KEYS`. A node that only declared its shape via
 * `enum` gains `type: 'string'` so it stays usable as a free-form value.
 */
function stripOversizedEnums(node: unknown, path: string, onDrop: (path: string, count: number) => void, inProgress: Set<unknown>): DropResult {
  if (Array.isArray(node)) {
    return stripArrayItems(node, path, onDrop, inProgress);
  }

  if (typeof node !== 'object' || node === null) {
    return { node, changed: false };
  }
  return stripObjectSchema(node as Record<string, unknown>, path, onDrop, inProgress);
}

function sanitizeToolParameters(schema: unknown, toolName: string, log: (message: string) => void): unknown {
  // Walk the computed fallback, not the raw schema: pre-change, a schema-less
  // tool sent { type: 'object', properties: {} } on both wire formats, and the
  // walker passes non-objects (undefined, null, strings) straight through.
  const effective: unknown =
    schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  try {
    const { node } = stripOversizedEnums(effective, 'root', (path, count) => {
      log(`schema relaxed: dropped oversized enum on ${toolName}${path} (${count} values)`);
    }, new Set<unknown>());
    return node;
  } catch (err) {
    // Degrade to exactly the pre-change payload rather than to an empty schema: a
    // detectable 400 beats a model invoking the tool with invented arguments.
    const detail = err instanceof Error ? err.message : String(err);
    log(`schema sanitization failed for ${toolName}: ${detail}; sending caller schema unchanged`);
    return effective;
  }
}

const discardLog = (): void => undefined;

export function formatProviderTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  isResponses: boolean,
  injectVerificationTools: boolean,
  log: (message: string) => void = discardLog
): WireToolDefinition[] | undefined {
  let toolsPayload: WireToolDefinition[] | undefined;
  if (tools && tools.length > 0) {
    if (isResponses) {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        name: clampToolName(tool.name),
        description: tool.description,
        parameters: sanitizeToolParameters(tool.inputSchema, tool.name, log),
      }));
    } else {
      toolsPayload = tools.map((tool) => ({
        type: 'function',
        function: {
          name: clampToolName(tool.name),
          description: tool.description,
          parameters: sanitizeToolParameters(tool.inputSchema, tool.name, log),
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
