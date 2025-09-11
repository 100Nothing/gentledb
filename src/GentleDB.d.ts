// src/GentleDB.d.ts

import type { Adapter } from 'lowdb';

/** Allowed event names (canonical + legacy for compatibility) */
export type GentleDBEventName =
    | 'beforeread'
    | 'beforewrite'
    | 'read'
    | 'write'
    | 'replace'
    | 'afterread'
    | 'afterwrite'
    | 'change'
    | 'lock'
    | 'unlock'
    | 'error'
    | 'watcher:error';

/**
 * Base event shape (generic over the DB data type)
 * Matches the runtime event produced by GentleDB v1.0.3.
*/
export interface GentleDBEventBase<T = any> {
    /** Canonical event name (e.g. 'write', 'read', 'lock', 'unlock', 'change', 'error'). */
    type: string;

    /** Operation hint (e.g. 'write', 'replace', 'resetDefault'). */
    op: string;

    /** Event timestamp (ms since epoch). */
    timestamp: number;

    /** Snapshot of data before the operation (deep-cloned). */
    oldData: T;

    /** Modifiable snapshot of data after the operation (deep-cloned). */
    newData: T;

    /** Whether listeners have called preventDefault(). */
    defaultPrevented: boolean;

    /** Whether listeners have called preventChain(). */
    chainPrevented: boolean;

    /** Optional result set by listener via setResult(). */
    _result: any;

    /** Prevent the event's default behavior from occurring. */
    preventDefault(): void;

    /** Suppress nested emissions from inside listeners. */
    preventChain(): void;

    /** Set the return result and mark defaultPrevented. */
    setResult(v: any): void;

    /** Get a value at a path. */
    get(path?: string): any;

    /** Set a value at a path. */
    set(path: string, value: any): this;

    /** Merge an object at a path. */
    merge(path: string, obj: object): this;

    /** Delete a value at a path. */
    delete(path: string): this;

    /** Commit the event (for clear semantics). */
    commit(): this;
}

/** `change` event contains a map of top-level key changes, plus origin metadata */
export interface ChangeEvent<T = any> extends GentleDBEventBase<T> {
    /** Canonical event name. */
    type: 'change';
    /** Map of top-level keys. */
    changes: Record<string, { old: any; new: any }>;
    /** Where the change originated: 'internal' when from this instance, 'external' when from file changes */
    source?: 'internal' | 'external';
}

/** Watcher error event */
export interface WatcherErrorEvent {
    /** Canonical event name. */
    type: 'watcher:error';
    /** Error object. */
    error: any;
    /** Optional filename. */
    filename?: string;
}

/** Union of all event types visible to consumers */
export type GentleDBEvent<T = any> = GentleDBEventBase<T> | ChangeEvent<T> | WatcherErrorEvent;

/** Function type for event listeners */
export type GentleDBEventHandler<T = any, E extends GentleDBEvent<T> = GentleDBEvent<T>> = (
    (evt: E & (E extends ChangeEvent<T> ? ChangeEvent<T> : E extends WatcherErrorEvent ? WatcherErrorEvent : GentleDBEvent<T>)) => any
);

/** Options accepted by the constructor */
export interface GentleDBOptions {
    /** Milliseconds to debounce writes (default: 100) */
    debounceWriteMs?: number;
    /** Milliseconds to debounce reads (default: 50) */
    debounceReadMs?: number;
    /** Default data to use when creating a new database (default: {}) */
    defaultData?: object;
    /** Whether to use case-sensitive comparisons for certain operations (default: false) */
    caseSensitive?: boolean;
    /** Maximum number of matches to return (default: 1000) */
    maxMatches?: number;
    /** Milliseconds to wait between lock retries (default: 50) */
    lockRetryDelayMs?: number;
    /** Milliseconds to wait before giving up on a lock (default: 5000) */
    lockTimeoutMs?: number;
    /** Milliseconds to consider a lock stale (default: 10000) */
    lockStaleMs?: number;
    /** Milliseconds to debounce file changes (default: 75) */
    watchDebounceMs?: number;
    /** Whether to register process exit handlers to attempt cleanup of lock files (default: true) */
    registerExitHandlers?: boolean;
}

/**
 * GentleDB - lightweight convenience wrapper around lowdb with debounced read/write,
 * file-watcher support, and a small event system.
*/
declare class GentleDB<T = any> {
    /**
     * Create a GentleDB instance.
     * @param adapterOrPath - Path to JSON file (string) or a lowdb `Adapter<T>` instance.
     * @param opts - runtime options
    */
    constructor(adapterOrPath: string | Adapter<T>, opts?: GentleDBOptions);

    /**
     * Subscribe to events. NOTE: In v1.0.3 `on()` does NOT return an unsubscribe function — call `off(name, fn)` to remove handlers.
     * Overloads provide stronger typing for `change`, `replace` and `watcher:error`.
    */
    on(name: GentleDBEventName, fn: GentleDBEventHandler<T>): void;
    on(name: 'change', fn: (evt: ChangeEvent<T>) => any | Promise<any>): void;
    on(name: 'watcher:error', fn: (evt: WatcherErrorEvent) => any | Promise<any>): void;

    /**
     * Unsubscribe. Returns true on success.
    */
    off(name: GentleDBEventName, fn: GentleDBEventHandler<T>): boolean;

    /** Read the DB (debounced). Resolves to a deep-cloned snapshot of the data. */
    read(): Promise<T>;

    /**
     * Write the DB (debounced).
     * - `write()` => writes current runtime data.
     * - `write(partial)` => merges top-level keys (partial merge behavior).
     *
     * Note: v1.0.3 makes `write()` a strictly-partial-write method and it **no longer accepts an options argument**.
    */
    write(partialOrFullData?: Partial<T> | T): Promise<any>;

    /** Replace entire DB root with provided data. Emits canonical `replace` event (and keeps legacy `write` compatibility events). */
    replace(fullData: T): Promise<any>;

    /** Replace DB contents with configured defaultData. Emits `replace` with `op === 'resetDefault'`. */
    resetDefault(): Promise<any>;

    /** Convenience alias for reading everything (calls `read()`). */
    getAll(): Promise<T>;

    /**
     * Search for matching leaf values.
     * Returns `{ partial: any[], exact: any[] }` where each entry is `{ origin, match }`.
    */
    findMatches(
        query: string | RegExp | Array<string | RegExp>,
        opts?: { caseSensitive?: boolean; searchKeys?: boolean; maxMatches?: number }
    ): Promise<{ partial: any[]; exact: any[] }>;

    /** Close watchers and cleanup (releases locks). */
    close(): Promise<void>;

    /**
     * Acquire a manual lock. If `permanent` is true, the instance will treat the lock as manually held
     * until `unlock(true)` is called or `restoreLock()` is used.
     * Emits `lock` event (cancellable).
    */
    lock(permanent?: boolean): Promise<boolean>;

    /**
     * Release a manual lock. If `permanent` is true, marks manual unlock.
     * Emits `unlock` event (cancellable).
    */
    unlock(permanent?: boolean): Promise<boolean>;

    /**
     * Restore default locking behavior (clears manual unlock flags).
    */
    restoreLock(): boolean;

    /** For convenience: respects the runtime implementation's Symbol.toPrimitive */
    [Symbol.toPrimitive](hint: string): any;
}

/** CommonJS export compatibility */
export = GentleDB;
export as namespace GentleDB;