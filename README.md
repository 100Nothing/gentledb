[Changelog for current: 1.0.2](https://github.com/100Nothing/gentledb/releases/tag/v1.0.2)

# GentleDB

A small convenience wrapper around lowdb providing debounced read/write, file-watching, a tiny event system, and safe on-disk locking.

## Install

Run:
`npm install gentledb`

Or when developing locally:
`npm install /path/to/local/gentledb-1.0.0.tgz`

## Quickstart

Small example usage:

```js
// CommonJS
const GentleDB = require('gentledb');

(async () => {
  const db = new GentleDB('./data.json', { defaultData: { users: [] } });
  await db.read();

  // Merge-style write (default)
  await db.write({ users: [{ id: 'a', name: 'Ada' }] });

  // Replace entire DB root (requests a replace op; replace is handled as a write with op='replace'
  // and a dedicated replace event/method is planned for 1.1.0)
  // await db.write({ users: [] }, { replace: true });

  const data = await db.getAll();
  console.log(data);

  await db.close();
})();
```

This example will create a `data.json` file in the current directory, write `{ users: [{ id: 'a', name: 'Ada' }] }` to it, get all data and log it.

## API (summary)

* `GentleDB constructor`

  * **adapterOrPath** — file path (string) or a lowdb Adapter instance.

  * **opts** — optional settings (debounce timings, defaultData, lock timeouts, etc.)

* `read() → Promise<any>`

  * **Returns** a deep-cloned snapshot of the data (debounced).

* `write(partialOrFullData?, { replace?: boolean }) → Promise<any>`

  * **By default** `write(partial)` merges top-level keys.

  * Use **{ replace: true }** to replace the entire root. Note: in v1.0.2 replace is expressed via `evt.op === 'replace'` on the `write` event; a distinct `replace` event/method will be added in 1.1.0.

  * Listeners can cancel a write by calling `evt.preventDefault()` or `evt.setResult(value)`. If they mutate `evt.newData`, those mutations will be honored before persistence.

* `getAll() → Promise<any>`

  * Alias for **read()**.

* `findMatches(query, opts?) → Promise<{ partial: any[]; exact: any[] }>`

  * Search leaf values; query accepts **string**, **RegExp**, or **array**.

* `on(eventName, handler) → () => void (unsubscribe)`

  * **Canonical supported events (v1.0.2):**

    * `write` (pre-operation — cancellable; `evt.op` indicates 'write' or 'replace' intent)
    * `read` (pre-operation — cancellable)
    * `lock` (pre-operation — cancellable)
    * `unlock` (pre-operation — cancellable)
    * `change` (post-operation — not cancellable; includes `source: 'internal'|'external'` and `changes`)
    * `error` (emitted for non-throwing errors; not cancellable)

  * **Legacy compatibility events (still emitted in 1.0.2; deprecated for 1.1.0):**

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
const db = new GentleDB<{ users: { id: string; name: string }[] }>('./data.json');
```

## Examples

See `src/examples/` (*basic usage*, *events*, *findMatches*).

### Notes about events & migration

* v1.0.2 introduces the canonical event shape and canonical names. Legacy `before*`/`after*` events are still emitted for compatibility but will be removed in 1.1.0 — migrate listeners to `write`, `read`, `lock`, `unlock`, `change`, `error` soon.
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