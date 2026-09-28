/**
 * Minimal local types for the proposed `chatSessionsProvider` API surface.
 *
 * VS Code publishes no typings for this proposal, so the spike is otherwise
 * untyped `any` end to end. These interfaces cover exactly the surface
 * src/chatsessions.ts touches — they are NOT the upstream API definition,
 * just enough structure to keep the code reviewable and lint-clean.
 * Delete this file when @types/vscode ships the finalized proposal.
 */

export interface OpencodeOptionItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly default?: boolean;
  readonly locked?: boolean;
}

export interface OpencodeOptionGroup {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly selected?: OpencodeOptionItem;
  readonly items: readonly OpencodeOptionItem[];
}

export interface OpencodeSessionOptions {
  readonly optionGroups?: readonly OpencodeOptionGroup[];
  readonly newSessionOptions?: Record<string, string | OpencodeOptionItem>;
}

export interface OpencodeSessionItem {
  readonly resource: unknown;
  readonly label: string;
}

/** Collection shape as shipped by the proposal (add/replace/get; no Map#set). */
export interface OpencodeItemCollection {
  readonly size: number;
  add(item: OpencodeSessionItem): void;
  replace(items: readonly OpencodeSessionItem[]): void;
  get(resource: unknown): OpencodeSessionItem | undefined;
}

export interface OpencodeController {
  readonly id: string;
  readonly items: OpencodeItemCollection;
  createChatSessionItem(resource: unknown, label: string): OpencodeSessionItem;
  createChatSessionInputState(groups: readonly OpencodeOptionGroup[]): unknown;
  newChatSessionItemHandler?: (context: unknown, token: unknown) => Promise<OpencodeSessionItem>;
  getChatSessionInputState?: (
    sessionResource: unknown,
    context: { readonly previousInputState?: { readonly sessionResource?: unknown } | undefined },
  ) => Promise<unknown>;
  dispose(): void;
}

export interface OpencodeConfigSelection {
  model?: string;
  effort?: string;
  mode?: string;
}

export interface OpencodeModelOption {
  readonly value: string;
  readonly name: string;
}

/** The subset of the proposed `vscode` surface the spike consumes. */
export interface OpencodeVscode {
  readonly Uri: { parse(value: string): unknown };
  readonly workspace?: {
    readonly workspaceFolders?: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
  };
  readonly ChatResponseMarkdownPart?: new (value: string) => unknown;
  readonly ChatResponseTurn?: new (
    response: unknown[],
    result: unknown,
    participant: string,
    command?: string,
  ) => unknown;
  readonly chat: {
    createChatSessionItemController(
      type: string,
      refresh: (token: unknown) => Promise<void>,
    ): OpencodeController;
    registerChatSessionContentProvider(
      scheme: string,
      provider: Record<string, unknown>,
    ): { dispose(): void };
  };
}
