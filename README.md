[Changelog for current: 1.0.3](https://github.com/100Nothing/gentledb/releases/tag/v1.0.3)

# GentleDB

A small convenience wrapper around lowdb providing debounced read/write, file-watching, a tiny event system, and safe on-disk locking.

## Install

Run:
`npm install gentledb`

Or when developing locally:
`npm install /path/to/local/gentledb-1.0.3.tgz`

## Quickstart

Small example usage (CommonJS):

```js
const GentleDB = require('gentledb');
const path = require('path');

(async () => {
  const db = new GentleDB(path.join(__dirname, 'data.json'), { defaultData: { users: [] } });
  await db.read();

  // Merge-style partial write (default)
  await db.write({ users: [{ id: 'a', name: 'Ada' }] });

  // Replace entire DB root (canonical API in v1.0.3)
  await db.replace({ users: [] });

  // Reset DB to configured defaultData
  await db.resetDefault();

  const data = await db.getAll();
  console.log(data);

  await db.close();
})();
```

This example will create a `data.json` file in the current directory, merge a `users` array, then demonstrate replace/reset flows, read all data and log it.

## API (summary)

* `GentleDB constructor`

  * **adapterOrPath** — file path (string) or a lowdb Adapter instance.

  * **opts** — optional settings (debounce timings, defaultData, lock timeouts, etc.)

* `read() → Promise<any>`

  * **Returns** a deep-cloned snapshot of the data (debounced).

* `write(partialOrFullData?) → Promise<any>`

  * **By default** `write(partial)` merges top-level keys (partial merge semantics).

  * **Important (v1.0.3):** `write()` is now strictly a partial-write method and **no longer accepts** an options argument. Use `replace()` to replace the entire root instead.

  * Listeners can cancel a write by calling `evt.preventDefault()` or `evt.setResult(value)`. If they mutate `evt.newData`, those mutations will be honored before persistence.

* `replace(fullData) → Promise<any>`

  * Replaces the entire DB root. Emits the canonical `replace` event. For backward compatibility, runtime also emits `write` compatibility events so existing listeners continue working until 1.1.0.

* `resetDefault() → Promise<any>`

  * Replaces DB contents with the configured `defaultData`. Emits the canonical `replace` event with `evt.op === 'resetDefault'`.

* `getAll() → Promise<any>`

  * Alias for **read()**.

* `findMatches(query, opts?) → Promise<{ partial: any[]; exact: any[] }>`

  * Search leaf values; query accepts **string**, **RegExp**, or **array**.

* `on(eventName, handler) → void` (v1.0.3)

  * **Note (v1.0.3):** `on()` no longer returns an unsubscribe function. Call `off(name, fn)` to remove listeners.

  * **Canonical supported events (v1.0.3):**

    * `write` (pre-operation — cancellable; `evt.op` indicates 'write', 'replace' or 'resetDefault' intent)
    * `replace` (pre/post — cancellable; canonical full-replace event)
    * `read` (pre-operation — cancellable)
    * `lock` (pre-operation — cancellable)
    * `unlock` (pre-operation — cancellable)
    * `change` (post-operation — not cancellable; includes `source: 'internal'|'external'` and `changes`)
    * `error` (emitted for non-throwing errors; not cancellable)

  * **Legacy compatibility events (still emitted in 1.0.3; deprecated for 1.1.0):**

    * `beforeread`, `beforewrite`, `afterread`, `afterwrite`
    * `watcher:error` (watcher error channel)

  * **Event helpers available on the event object:**

    * `evt.preventDefault()` — cancel the operation (no result returned unless `evt.setResult()` used).
    * `evt.setResult(val)` — cancel the operation and resolve the original caller with `val`.
    * `evt.preventChain()` — prevent nested event emissions that would otherwise be caused by code invoked inside this listener (useful to avoid re-entrancy).
    * Mutation helpers that operate on the `newData` snapshot: `evt.get(path)`, `evt.set(path, val)`, `evt.merge(path, obj)`, `evt.delete(path)`, `evt.commit()`.

  * **`change` handler** receives a changes map with **top-level keys** and metadata:

    * `evt.changes` — `{ key: { old, new } }`
    * `evt.source` — `'internal'` when change originates from this instance, `'external'` when resulting from on-disk modification.

* `off(eventName, handler) → boolean`

  * Unsubscribe; **returns true** if removed.

* `close() → Promise<void>`

  * **Stops watchers** and releases locks.

* `lock(permanent?: boolean) → Promise<boolean>`

  * Acquire a manual lock; if `permanent` is `true`, the instance treats the lock as manually held until `unlock(true)` is called or `restoreLock()` is used. Emits a cancellable `lock` event.

* `unlock(permanent?: boolean) → Promise<boolean>`

  * Release manual lock; if `permanent` is `true`, the instance will mark a manual unlock. Emits a cancellable `unlock` event.

* `restoreLock() → boolean`

  * Reset manual lock override state.

## Types

If you use TypeScript, `src/index.d.ts` ships type declarations. The package is typed generically so you can annotate the root shape:

```ts
import GentleDB from 'gentledb';
const db = new GentleDB<{ users: { id: string; name: string }[] }>("./data.json");
```

## Examples

See `src/examples/` (*basic usage*, *events*, *findMatches*).

### Notes about events & migration

* v1.0.3 introduces a canonical `replace` event/method and makes `write()` a partial-only method. Runtime emits legacy `before*`/`after*` compatibility events for now, but those will be removed in 1.1.0 — migrate listeners to `write`, `replace`, `read`, `lock`, `unlock`, `change`, `error` as appropriate.
* Use `evt.setResult()` if you need the listener to cancel and return a specific value; use `evt.preventDefault()` if you only want to cancel.
* Use `evt.preventChain()` inside listeners when you want to prevent nested event emissions from code invoked inside the listener.

## Publishing notes (for maintainers)

Ensure **lowdb** is listed in *dependencies* not *devDependencies*.

If shipping source (no build), keep `type: "commonjs"` in `package.json` or rename runtime files to **.cjs**.

Consider adding a `dist/` build and **ESM** entry for broader compatibility.

## Links

* [My GitHub (@100Nothing)](https://github.com/100Nothing)
* [GitHub Repo](https://github.com/100Nothing/gentledb)

  * [Issues](https://github.com/100Nothing/gentledb/issues)
* [NPM Package](https://www.npmjs.com/package/gentledb)
* [LowDB](https://github.com/typicode/lowdb)