// src/index.d.ts

import type { Adapter } from 'lowdb';

/** Allowed event names */
export type GentleDBEventName =
    | 'beforeread'
    | 'beforewrite'
    | 'read'
    | 'write'
    | 'afterread'
    | 'afterwrite'
    | 'change'
    | 'watcher:error';

/** Base event shape (generic over the DB data type) */
export interface GentleDBEventBase<T = any> {
    type: string;
    oldData: T;
    newData: T;
    _prevented: boolean;
    _result: any;

    // control flow helpers
    preventDefault(): void;
    setResult(v: any): void;

    // mutation helpers that operate on the *newData* snapshot
    get(path?: string): any;
    set(path: string, value: any): this;
    merge(path: string, obj: object): this;
    delete(path: string): this;
    commit(): this;
}

/** `change` event contains a map of top-level key changes */
export interface ChangeEvent<T = any> extends GentleDBEventBase<T> {
    type: 'change';
    changes: Record<string, { old: any; new: any }>;
}

/** Watcher error event */
export interface WatcherErrorEvent {
    type: 'watcher:error';
    error: any;
    filename?: string;
}

export type GentleDBEvent<T = any> = GentleDBEventBase<T> | ChangeEvent<T> | WatcherErrorEvent;

/** Handler type; specific event overloads are provided on the class for better inference */
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
}

/**
 * GentleDB — lightweight convenience wrapper around lowdb with debounced read/write,
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
     * Overloads provide better typing for `change` and `watcher:error` events.
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
    */
    write(partialOrFullData?: Partial<T> | T, opts?: { replace?: boolean }): Promise<void>;

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

    /** For convenience: respects the runtime implementation's Symbol.toPrimitive */
    [Symbol.toPrimitive](hint: string): any;
}

/** CommonJS export compatibility */
export = GentleDB;
export as namespace GentleDBModule;