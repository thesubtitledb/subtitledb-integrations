/**
 * The few extension APIs this extension calls, typed by hand rather than through
 * @types/chrome. Chrome and Firefox both offer them under `chrome` and both return
 * promises in Manifest V3.
 */
declare namespace chrome {
  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: {
      addListener(
        cb: (message: unknown, sender: unknown, reply: (response: unknown) => void) => boolean,
      ): void;
    };
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function query(q: { active?: boolean; currentWindow?: boolean; url?: string }): Promise<Tab[]>;
    function get(id: number): Promise<Tab>;
  }
  namespace scripting {
    interface Target {
      tabId: number;
      allFrames?: boolean;
      frameIds?: number[];
    }
    interface InjectionResult<T> {
      frameId: number;
      result?: T;
    }
    function executeScript<A extends unknown[], T>(o: {
      target: Target;
      files?: string[];
      func?: (...args: A) => T;
      args?: A;
    }): Promise<InjectionResult<Awaited<T>>[]>;
  }
  namespace permissions {
    function contains(p: { origins?: string[] }): Promise<boolean>;
    function request(p: { origins?: string[] }): Promise<boolean>;
  }
  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const sync: Area;
    const onChanged: {
      addListener(
        cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void,
      ): void;
    };
  }
}
