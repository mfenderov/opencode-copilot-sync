export class EventEmitter {
  #listeners = new Set();
  event = (listener) => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  };
  fire(data) {
    for (const listener of this.#listeners) {
      try {
        listener(data);
      } catch {}
    }
  }
}
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
export class LanguageModelTextPart { constructor(value) { this.value = value; } }
export class LanguageModelDataPart {
  constructor(data, mimeType = 'application/json') {
    this.data = data;
    this.mimeType = mimeType;
  }
  static json(value, mimeType = 'application/json') {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
  }
}
export class LanguageModelToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
export class LanguageModelToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
export class LanguageModelThinkingPart { constructor(value, id) { this.value = value; this.id = id; } }
export class LanguageModelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LanguageModelError';
    this.code = code;
  }
  static NoPermissions(message) {
    return new LanguageModelError(message, 'NoPermissions');
  }
  static NotFound(message) {
    return new LanguageModelError(message, 'NotFound');
  }
  static Blocked(message) {
    return new LanguageModelError(message, 'Blocked');
  }
}
export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {} }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
};
export const lm = {
  registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
};
export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};
export class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
export class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
export class TreeItem {
  constructor(label, collapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const env = {
  openExternal: async () => true,
  remoteName: undefined,
  appName: 'Visual Studio Code',
};

export const Uri = {
  parse: (str) => ({
    toString: () => str,
    path: str,
    scheme: str.split(':')[0],
  }),
};
class Collection extends Map {
  replace(items) { this.clear(); for (const i of items) this.set(i.resource.toString(), i); }
  add(item) { this.set(item.resource.toString(), item); return this; }
}
function createChatSessionItemController(id, refreshHandler) {
  const listeners = [];
  const controller = {
    id, refreshHandler,
    items: new Collection(),
    createChatSessionItem: (resource, label) => ({ resource, label, timing: { startTime: Date.now() } }),
    onDidChangeChatSessionItemState: (fn) => { listeners.push(fn); return { dispose() {} }; },
    dispose() {},
  };
  return controller;
}
export const chat = { createChatSessionItemController, registerChatSessionContentProvider: (_s, _p) => ({ dispose() {} }) };
export default { chat, Uri, ThemeIcon, EventEmitter };


