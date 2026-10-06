import type { SseEvent } from './sse-reader.js';

type Metadata = Record<string, unknown>;
type ToolDisposition = 'emitted' | 'malformed' | 'synthetic';

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const RESPONSE_STATUSES = new Set(['completed', 'incomplete', 'failed', 'in_progress', 'queued', 'cancelled']);
const INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter']);
const OUTPUT_ITEM_TYPES = new Set(['message', 'reasoning', 'function_call']);
const MESSAGE_PHASES = new Set(['commentary', 'final_answer']);

function diagnosticRecord(value: unknown): Metadata | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Metadata
    : undefined;
}

function allowedValue(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

export class ResponsesStreamDiagnostics {
  private seen = false;
  private terminalEvent = 'missing';
  private status = 'unknown';
  private incompleteReason = 'none';
  private readonly items = new Map<string, { type: string; phase: string }>();
  private readonly toolAliases = new Map<string, number>();
  private receivedToolCalls = 0;
  private readonly dispositions = {
    emitted: new Set<string>(), malformed: new Set<string>(), synthetic: new Set<string>(),
  };

  observe(event: SseEvent): void {
    const data = diagnosticRecord(event.data);
    if (!data || !event.type.startsWith('response.')) return;
    this.seen = true;
    if (TERMINAL_EVENTS.has(event.type)) {
      this.terminalEvent = event.type;
      this.observeTerminal(diagnosticRecord(data.response));
    } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      this.observeItem(data.item, typeof data.output_index === 'number' ? data.output_index : undefined);
    }
  }

  private observeTerminal(response: Metadata | undefined): void {
    this.status = allowedValue(response?.status, RESPONSE_STATUSES, 'unknown');
    this.incompleteReason = allowedValue(diagnosticRecord(response?.incomplete_details)?.reason, INCOMPLETE_REASONS, 'none');
    if (Array.isArray(response?.output)) {
      this.items.clear();
      response.output.forEach((item, index) => { this.observeItem(item, index); });
    }
  }

  private observeItem(value: unknown, index: number | undefined): void {
    const item = diagnosticRecord(value);
    if (!item) return;
    const type = typeof item.type === 'string' && OUTPUT_ITEM_TYPES.has(item.type) ? item.type : 'other';
    const phase = allowedValue(item.phase, MESSAGE_PHASES, 'unspecified');
    const identity = typeof item.id === 'string' ? item.id
      : typeof item.call_id === 'string' ? item.call_id : `anonymous:${this.items.size}`;
    const key = index !== undefined ? `index:${index}` : identity;
    this.items.set(key, { type, phase });
    if (type === 'function_call') this.observeToolCall(item, index);
  }

  private observeToolCall(item: Metadata, index: number | undefined): void {
    const aliases: string[] = [];
    if (typeof item.id === 'string') aliases.push(`id:${item.id}`);
    if (typeof item.call_id === 'string') aliases.push(`call:${item.call_id}`);
    if (aliases.length === 0 && index !== undefined) aliases.push(`index:${index}`);
    const existing = aliases.map((alias) => this.toolAliases.get(alias)).find((id) => id !== undefined);
    const identity = existing ?? this.receivedToolCalls++;
    for (const alias of aliases) this.toolAliases.set(alias, identity);
  }

  recordToolDisposition(id: string, disposition: ToolDisposition): void {
    this.dispositions[disposition].add(id);
  }

  summary(): string | undefined {
    if (!this.seen) return undefined;
    const outputItems = { message: 0, reasoning: 0, function_call: 0, other: 0 };
    const messagePhases = { commentary: 0, final_answer: 0, unspecified: 0, unknown: 0 };
    for (const item of this.items.values()) {
      outputItems[item.type as keyof typeof outputItems]++;
      if (item.type === 'message') messagePhases[item.phase as keyof typeof messagePhases]++;
    }
    return `Responses stream summary: ${JSON.stringify({
      terminalEvent: this.terminalEvent,
      status: this.status,
      incompleteReason: this.incompleteReason,
      outputItems,
      messagePhases,
      toolCalls: {
        received: this.receivedToolCalls,
        emitted: this.dispositions.emitted.size,
        malformed: this.dispositions.malformed.size,
        synthetic: this.dispositions.synthetic.size,
      },
    })}`;
  }
}
