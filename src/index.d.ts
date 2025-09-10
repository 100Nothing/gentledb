// src/index.d.ts

import type { Adapter } from 'lowdb';

/** Allowed event names (canonical + legacy for compatibility) */
export type GentleDBEventName =
    | 'beforeread'
    | 'beforewrite'
    | 'read'
    | 'write'
    | 'afterread'
    | 'afterwrite'
    | 'change'
    | 'lock'
    | 'unlock'
    | 'error'
    | 'watcher:error';

/**
 * Base event shape (generic over the DB data type)
 * Matches the runtime event produced by GentleDB v1.0.2.
*/
export interface GentleDBEventBase<T = any> {
    /** canonical event name (e.g. 'write', 'read', 'lock', 'unlock', 'change', 'error') */
    type: string;

    /** operation hint (e.g. 'write' or 'replace' when a replace is requested) */
    op: string;

    /** event timestamp (ms since epoch) */
    timestamp: number;

    /** snapshot of data before the operation (deep-cloned) */
    oldData: T;

    /** modifiable snapshot of data after the operation (deep-cloned) */
    newData: T;

    /** whether listeners have called preventDefault() */
    defaultPrevented: boolean;

    /** whether listeners have called preventChain() */
    chainPrevented: boolean;

    /** optional result set by listener via setResult() */
    _result: any;

    // Control flow helpers
    preventDefault(): void;
    preventChain(): void;
    setResult(v: any): void;

    // Mutation helpers that operate on the *newData* snapshot
    get(path?: string): any;
    set(path: string, value: any): this;
    merge(path: string, obj: object): this;
    delete(path: string): this;
    commit(): this;
}

/** `change` event contains a map of top-level key changes, plus origin metadata */
export interface ChangeEvent<T = any> extends GentleDBEventBase<T> {
    type: 'change';
    /** Map of top-level keys -> { old, new } */
    changes: Record<string, { old: any; new: any }>;
    /** Where the change originated: 'internal' when from this instance, 'external' when from file changes */
    source?: 'internal' | 'external';
}

/** Watcher error event */
export interface WatcherErrorEvent {
    type: 'watcher:error';
    error: any;
    filename?: string;
}

/** Union of all event types visible to consumers */
export type GentleDBEvent<T = any> = GentleDBEventBase<T> | ChangeEvent<T> | WatcherErrorEvent;

/** Generic event handler */
export type GentleDBEventHandler<T = any, E extends GentleDBEvent<T> = GentleDBEvent<T>> = (
    evt: E
) => any | Promise<any>;

/** Options accepted by the constructor */
export interface GentleDBOptions {
    debounceWriteMs?: number;
    debounceReadMs?: number;
    defaultData?: object;
    caseSensitive?: boolean;
    maxMatches?: number;
    lockRetryDelayMs?: number;
    lockTimeoutMs?: number;
    lockStaleMs?: number;
    watchDebounceMs?: number;
    /** whether to register process exit handlers to attempt cleanup of lock files (default: true) */
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
     * Subscribe to events. Returns an *unsubscribe* function.
     * Overloads provide stronger typing for `change` and `watcher:error`.
    */
    on(name: 'change', fn: (evt: ChangeEvent<T>) => any | Promise<any>): () => void;
    on(name: 'watcher:error', fn: (evt: WatcherErrorEvent) => any | Promise<any>): () => void;
    on(name: GentleDBEventName, fn: GentleDBEventHandler<T>): () => void;

    /**
     * Unsubscribe. Returns true on success.
    */
    off(name: GentleDBEventName, fn: GentleDBEventHandler<T>): boolean;

    /** Read the DB (debounced). Resolves to a deep-cloned snapshot of the data. */
    read(): Promise<T>;

    /**
     * Write the DB (debounced).
     * - `write()` => writes current runtime data.
     * - `write(partial)` => merges top-level keys (default).
     * - `write(full, { replace: true })` => replaces entire root with `full`.
     *
     * Note: v1.0.2 preserves the `op` flag `replace` on events when replace is requested,
     * but does not emit a separate `replace` event type (that will be a method/event in 1.1.0).
    */
    write(partialOrFullData?: Partial<T> | T, opts?: { replace?: boolean }): Promise<any>;

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
export as namespace GentleDBModule;