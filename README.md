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

  await db.write({ users: [{ id: 'a', name: 'Ada' }] });
  const data = await db.getAll();
  console.log(data);

  await db.close();
})();
```

This example will create a `data.json` file in the current directory, and write `{ users: [{ id: 'a', name: 'Ada' }] }` to it, get all data and log it.

## API (summary)

- `GentleDB constructor`

    - **adapterOrPath** — file path (string) or a lowdb Adapter instance.

    - **opts** — optional settings (debounce timings, defaultData, lock timeouts, etc.)

- `read() → Promise<any>`

    - **Returns** a deep-cloned snapshot of the data (debounced).

- `write(partialOrFullData?, { replace?: boolean }) → Promise<void>`

    - **By default** write(partial) merges top-level keys.

    - Use **{ replace: true }** to replace the entire root.

- `getAll() → Promise<any>`

    - Alias for **read()**.

- `findMatches(query, opts?) → Promise<{ partial: any[]; exact: any[] }>`

    - Search leaf values; query accepts **string**, **RegExp**, or **array**.

- `on(eventName, handler) → () => void (unsubscribe)`

    - **Supported events:**

        - *beforeread*, *beforewrite*, *read*, *write*, *afterread*, *afterwrite*, *change*, *watcher:error*

    - **change** handler receives a changes map with **top-level keys**.

- `off(eventName, handler) → boolean`

    - Unsubscribe; **returns true** if removed.

- `close() → Promise<void>`

    - **Stops watchers** and releases locks.

## Types

If you use TypeScript, src/index.d.ts ships type declarations. The package is typed generically so you can annotate the root shape:

```ts
import GentleDB from 'gentledb';
const db = new GentleDB<{ users: { id: string; name: string }[] }>('./data.json');
```

### Examples

See `src/examples/` (*basic usage*, *events*, *findMatches*).

## Publishing notes (for maintainers)

Ensure **lowdb** is listed in <u>*dependencies*</u> not <u>*devDependencies*</u>.

If shipping source (no build), keep type: "commonjs" in `package.json` or rename runtime files to **.cjs**.

Consider adding a `dist/` build and **ESM** entry for broader compatibility.

## Links

- [My GitHub (@100Nothing)](https://github.com/100Nothing)
- [GitHub Repo](https://github.com/100Nothing/gentledb)
    - [Issues](https://github.com/100Nothing/gentledb/issues)
- [NPM Package](https://www.npmjs.com/package/gentledb)
- [LowDB](https://github.com/typicode/lowdb)