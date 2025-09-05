// src/GentleDB.js

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

// Stable JSON.stringify helper
function stableStringify(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
        return '[' + v.map(stableStringify).join(',') + ']';
    }
    if (typeof v === 'object') {
        const keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    // Fallback for other types
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}

class GentleDB {
    constructor(adapterOrPath, opts = {}) {
        // PUBLIC OPTIONS (defaults)
        this.opts = Object.assign({
            debounceWriteMs: 100,
            debounceReadMs: 50,
            defaultData: {},
            caseSensitive: false,
            maxMatches: 1000,
            lockRetryDelayMs: 50,
            lockTimeoutMs: 5000,
            lockStaleMs: 10000,
            watchDebounceMs: 75
        }, opts);

        // Event emitter
        this._ee = new EventEmitter();
        // internal lowdb references (populated in _initPromise)
        this._low = null;
        this._adapter = null;
        this._filePath = null;
        this._lockPath = null;
        this._heldLockHandle = null;

        // Debounce/serialization state
        this._writeTimer = null;
        this._readTimer = null;
        this._pendingWrite = null;
        this._pendingRead = null;
        this._chain = Promise.resolve();

        // Watcher flags
        this._watcher = null;
        this._suppressWatchEvents = false;
        this._isWriting = false;
        this._lastOnDiskSnapshot = null;

        // Expose an init promise that resolves once lowdb is loaded and an initial read/write
        // (this mirrors existing code patterns using this._initPromise)
        this._initPromise = (async () => {
            // Resolve lowdb and JSONFile constructor, supports require() or dynamic import
            const { Low, JSONFile } = await GentleDB._loadLowdbModule();

            // Build adapter
            let adapter = adapterOrPath;
            let filePathCandidate = null;

            if (typeof adapterOrPath === 'string') {
                // path string
                filePathCandidate = path.resolve(String(adapterOrPath));

                // Ensure directory exists
                try {
                    const dir = path.dirname(filePathCandidate);
                    await fsp.mkdir(dir, { recursive: true });
                } catch (err) {
                    throw new Error(`GentleDB: failed to ensure directory exists from path ${filePathCandidate}: ${err && err.message ? err.message : String(err)}`);
                }

                // Create adapter
                adapter = new JSONFile(filePathCandidate);
                this._filePath = filePathCandidate;
            } else if (adapterOrPath && typeof adapterOrPath === 'object' && adapterOrPath !== null) {
                // adapter instance - try to locate a path property (best-effort)
                try {
                    this._filePath = adapter.filename || adapter.filePath || adapter.path || adapter.file || null;
                } catch (e) {
                    this._filePath = null;
                    // Let lowdb fail if it can't find a path and throw
                }
            } else {
                throw new Error('GentleDB: adapterOrPath must be a path string or a lowdb adapter instance.');
            }

            // Store file path info (preserve any adapter-derived path; prefer explicit string path)
            this._filePath ??= filePathCandidate ? filePathCandidate : null;
            this._lockPath = this._filePath ? `${this._filePath}.lock` : null;

            // Save adapter and low instance
            this._adapter = adapter;
            try {
                this._low = new Low(this._adapter, this.opts.defaultData || {});
            } catch (err) {
                // If the adapter shape is unexpected, surface a helpful error
                throw new Error(`GentleDB: failed to construct Low(adapter) — adapter provided must be a lowdb adapter instance or a path string. Underlying error: ${err && err.message ? err.message : String(err)}`);
            }

            // Perform initial reads and defaults (like your original implementation)
            try {
                await this._low.read();
            } catch (e) {
                // read may fail if file absent; ignore for now
            }
            if (this._low.data === undefined || this._low.data === null) {
                this._low.data = GentleDB._cloneSafe(this.opts.defaultData);
                try { await this._low.write(); } catch (e) { /* ignore write errors here */ }
            }
            try {
                await this._low.read();
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);
            } catch (e) {
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(this.opts.defaultData);
            }

            // Start file watcher if we have a real file path
            if (this._filePath) {
                this._startWatcher();
            }

            // Return the ready state
            return true;
        })();
    }

    on(name, fn) {
        this._ee.on(name, fn);
        return () => { try { this._ee.off(name, fn); } catch (e) { /* ignore */ } };
    }

    off(name, fn) {
        try {
            this._ee.off(name, fn);
            return true;
        } catch (e) {
            return false;
        }
    }

    async read() {
        await this._initPromise;
        return this._debouncedRead();
    }

    async write(partialOrFullData = undefined, opts = {}) {
        await this._initPromise;
        const useReplace = Boolean(opts.replace);
        return this._debouncedWrite(partialOrFullData, { replace: useReplace });
    }

    async getAll() {
        await this._initPromise;
        // returns clone of current data via read flow
        return this.read();
    }

    async findMatches(query, opts = {}) {
        await this._initPromise;
        const cfg = Object.assign({
            caseSensitive: this.opts.caseSensitive,
            searchKeys: false,
            maxMatches: this.opts.maxMatches
        }, opts);

        const tokens = this._parseToTokens(query, cfg);
        if (tokens.length === 0) return { partial: [], exact: [] };

        // read adapter to ensure we have latest on-disk content
        await this._low.read();
        const snapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);

        // Walk tree to collect leaves
        const leaves = [];
        const pushLeaf = (origin, val) => leaves.push({ origin: origin || '(root)', val });

        const walk = (node, curPath) => {
            if (node === null || node === undefined) { pushLeaf(curPath, node); return; }
            if (Array.isArray(node)) {
                if (node.length === 0) { pushLeaf(curPath, node); return; }
                for (let i = 0; i < node.length; i++) walk(node[i], `${curPath || '(root)'}[${i}]`);
            } else if (typeof node === 'object') {
                const keys = Object.keys(node);
                if (keys.length === 0) { pushLeaf(curPath, node); return; }
                for (const k of keys) {
                    const childPath = curPath ? `${curPath}.${k}` : k;
                    if (cfg.searchKeys) pushLeaf(`${childPath}#key`, k);
                    walk(node[k], childPath);
                }
            } else {
                pushLeaf(curPath, node);
            }
        };
        walk(snapshot, '');

        const leafRecords = leaves.map(l => {
            const val = l.val;
            const str = (val === null || val === undefined) ? String(val) : (typeof val === 'object' ? JSON.stringify(val) : String(val));
            return { origin: l.origin, val, str, norm: cfg.caseSensitive ? str : str.toLowerCase() };
        });

        const partial = [];
        const exact = [];
        const seen = new Set();
        const limit = Math.max(1, Math.floor(cfg.maxMatches));

        for (const tk of tokens) {
            if (partial.length + exact.length >= limit) break;
            for (const leaf of leafRecords) {
                if (partial.length + exact.length >= limit) break;
                const keyExact = `e:${leaf.origin}:${String(tk.token)}`;
                const keyPartial = `p:${leaf.origin}:${String(tk.token)}`;

                if (tk.isRegex) {
                    const re = tk.regex;
                    if (tk.exactOnly) {
                        const anchored = new RegExp(`^(?:${re.source})$`, re.flags);
                        if (anchored.test(leaf.str) && !seen.has(keyExact)) { exact.push({ origin: leaf.origin, match: leaf.val }); seen.add(keyExact); }
                    } else {
                        if (re.test(leaf.str) && !seen.has(keyPartial)) { partial.push({ origin: leaf.origin, match: leaf.val }); seen.add(keyPartial); }
                    }
                    continue;
                }

                const tokenNorm = cfg.caseSensitive ? tk.token : tk.token.toLowerCase();

                if (leaf.norm === tokenNorm) {
                    if (!seen.has(keyExact)) { exact.push({ origin: leaf.origin, match: leaf.val }); seen.add(keyExact); }
                    continue;
                }
                if (tk.exactOnly) continue;
                if (leaf.norm.includes(tokenNorm)) {
                    if (!seen.has(keyPartial)) { partial.push({ origin: leaf.origin, match: leaf.val }); seen.add(keyPartial); }
                }
            }
        }

        return { partial, exact };
    }

    async close() {
        try {
            if (this._watcher && typeof this._watcher.close === 'function') this._watcher.close();
            if (this._filePath) fs.unwatchFile(this._filePath);
        } catch (e) { /* ignore */ }
        this._watcher = null;
        try { await this._releaseLock(); } catch (e) { /* ignore */ }
    }

    // Helpers

    static async _loadLowdbModule() {
        // Try synchronous require first (most users on older lowdb or bundlers)
        try {
            const m = require('lowdb');
            // Some versions export JSONFile alongside Low
            if (m && m.Low && m.JSONFile) return { Low: m.Low, JSONFile: m.JSONFile };

            // Some older docs suggest JSONFile lives at 'lowdb/node' -> attempt to require it.
            try {
                const nodePart = require('lowdb/node');
                if (nodePart && nodePart.JSONFile) return { Low: m.Low || m.Low, JSONFile: nodePart.JSONFile };
            } catch (e) { /* ignore */ }

            // If JSONFile isn't present but Low is, we can still proceed relying on consumer providing adapter
            if (m && m.Low) {
                if (m.JSONFile) return { Low: m.Low, JSONFile: m.JSONFile };
                // attempt dynamic import to locate JSONFile (some installs export it from lowdb/node under ESM)
            }
        } catch (err) {
            // require may fail for ESM packages — we'll fallback to dynamic import below
        }

        // Fallback: dynamic import (works if Node supports it and package is ESM)
        try {
            // Try import('lowdb') first
            const mod = await import('lowdb').then(m => m).catch(() => null);
            const modNode = await import('lowdb/node').then(m => m).catch(() => null);

            const Low = mod && (mod.Low || mod.default?.Low) ? (mod.Low || mod.default?.Low) : (modNode && (modNode.Low || modNode.default?.Low) ? (modNode.Low || modNode.default?.Low) : null);
            const JSONFile = (mod && (mod.JSONFile || mod.default?.JSONFile)) || (modNode && (modNode.JSONFile || modNode.default?.JSONFile));
            if (Low && JSONFile) return { Low, JSONFile };

            // If Low found but JSONFile not found, return Low and leave JSONFile undefined (adapter must be provided)
            if (Low) return { Low, JSONFile: JSONFile };

            throw new Error('Could not locate lowdb exports (Low/JSONFile). Ensure lowdb is installed (npm i lowdb) and that your Node environment supports ESM or use a compatible lowdb version.');
        } catch (err) {
            throw new Error(`GentleDB requires lowdb (v3+). Failed to load lowdb dynamically: ${err && err.message ? err.message : String(err)}. Install lowdb via: npm i lowdb`);
        }
    }

    async _emitSequential(name, evt) {
        const listeners = this._ee.listeners(name).slice();
        for (const l of listeners) {
            try {
                const res = l(evt);
                if (res && typeof res.then === 'function') await res;
            } catch (err) {
                evt._listenerError = evt._listenerError || [];
                evt._listenerError.push({ listener: l, error: err });
            }
        }
        return evt;
    }

    _debouncedRead() {
        return new Promise((resolve, reject) => {
            if (!this._pendingRead) this._pendingRead = { resolvers: [], rejecters: [] };
            this._pendingRead.resolvers.push(resolve);
            this._pendingRead.rejecters.push(reject);

            if (this._readTimer) clearTimeout(this._readTimer);
            this._readTimer = setTimeout(() => {
                const pending = this._pendingRead;
                this._pendingRead = null;
                this._readTimer = null;

                this._chain = this._chain.then(async () => {
                    try {
                        const old = GentleDB._cloneSafe(this._low && this._low.data !== undefined ? this._low.data : {});
                        const beforereadEvt = this._makeEvent('beforeread', old, GentleDB._cloneSafe(old));
                        await this._emitSequential('beforeread', beforereadEvt);

                        if (beforereadEvt._prevented) {
                            const result = (typeof beforereadEvt._result !== 'undefined') ? await beforereadEvt._result : GentleDB._cloneSafe(beforereadEvt.newData);
                            const readEvt = this._makeEvent('read', old, GentleDB._cloneSafe(result));
                            await this._emitSequential('read', readEvt);
                            const afterEvt = this._makeEvent('afterread', old, GentleDB._cloneSafe(result));
                            await this._emitSequential('afterread', afterEvt);
                            for (const r of pending.resolvers) r(GentleDB._cloneSafe(result));
                            return;
                        }

                        // adapter read
                        await this._low.read();
                        const snapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);
                        try { this._lastOnDiskSnapshot = GentleDB._cloneSafe(snapshot); } catch (e) { /* ignore */ }
                        const readEvt = this._makeEvent('read', old, GentleDB._cloneSafe(snapshot));
                        await this._emitSequential('read', readEvt);
                        const afterEvt = this._makeEvent('afterread', old, GentleDB._cloneSafe(snapshot));
                        await this._emitSequential('afterread', afterEvt);
                        for (const r of pending.resolvers) r(GentleDB._cloneSafe(snapshot));
                    } catch (err) {
                        for (const rej of pending.rejecters) rej(err);
                    }
                });
            }, Math.max(0, Number(this.opts.debounceReadMs) || 0));
        });
    }

    _debouncedWrite(incomingData, opts) {
        return new Promise((resolve, reject) => {
            if (!this._pendingWrite) this._pendingWrite = { data: incomingData, resolvers: [], rejecters: [], opts: opts || {} };
            else this._pendingWrite.data = incomingData;
            this._pendingWrite.opts = opts || this._pendingWrite.opts;

            this._pendingWrite.resolvers.push(resolve);
            this._pendingWrite.rejecters.push(reject);

            if (this._writeTimer) clearTimeout(this._writeTimer);
            this._writeTimer = setTimeout(() => {
                const pending = this._pendingWrite;
                this._pendingWrite = null;
                this._writeTimer = null;

                this._chain = this._chain.then(async () => {
                    try {
                        const oldData = GentleDB._cloneSafe(this._low && this._low.data !== undefined ? this._low.data : {});
                        let proposed;
                        if (typeof pending.data === 'undefined') proposed = GentleDB._cloneSafe(this._low && this._low.data !== undefined ? this._low.data : {});
                        else {
                            if (pending.opts && pending.opts.replace) proposed = GentleDB._cloneSafe(pending.data);
                            else proposed = this._deepMerge(GentleDB._cloneSafe(oldData), pending.data);
                        }

                        // beforewrite
                        const beforeEvt = this._makeEvent('beforewrite', oldData, GentleDB._cloneSafe(proposed));
                        await this._emitSequential('beforewrite', beforeEvt);

                        if (beforeEvt._prevented) {
                            if (typeof beforeEvt._result !== 'undefined') await Promise.resolve(beforeEvt._result);
                            for (const r of pending.resolvers) r();
                            const afterEvt = this._makeEvent('afterwrite', oldData, GentleDB._cloneSafe(beforeEvt.newData));
                            await this._emitSequential('afterwrite', afterEvt);
                            return;
                        }

                        // Update runtime
                        const finalData = GentleDB._cloneSafe(beforeEvt.newData);
                        // set into _low.data before write
                        if (!this._low) throw new Error('GentleDB internal error: lowdb instance not initialized.');
                        this._low.data = finalData;

                        // Acquire lock
                        await this._acquireLock();
                        this._isWriting = true;
                        this._suppressWatchEvents = true;

                        const writeEvt = this._makeEvent('write', oldData, GentleDB._cloneSafe(finalData));
                        await this._emitSequential('write', writeEvt);

                        // persist
                        try {
                            await this._low.write();
                            try { this._lastOnDiskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data); } catch (e) { /* ignore */ }
                        } finally {
                            // release flags & lock
                            this._suppressWatchEvents = false;
                            this._isWriting = false;
                            try { await this._releaseLock(); } catch (e) { /* ignore */ }
                        }

                        const afterEvt = this._makeEvent('afterwrite', oldData, GentleDB._cloneSafe(finalData));
                        await this._emitSequential('afterwrite', afterEvt);

                        // compute top-level changes and emit change
                        const changes = this._computeTopLevelChanges(oldData, finalData);
                        if (Object.keys(changes).length > 0) {
                            const changeEvt = this._makeEvent('change', oldData, GentleDB._cloneSafe(finalData));
                            changeEvt.changes = changes;
                            await this._emitSequential('change', changeEvt);
                        }

                        for (const r of pending.resolvers) r();
                    } catch (err) {
                        // ensure lock release
                        try { this._suppressWatchEvents = false; this._isWriting = false; await this._releaseLock(); } catch (e) { /* ignore */ }
                        for (const rej of pending.rejecters) rej(err);
                    }
                });
            }, Math.max(0, Number(this.opts.debounceWriteMs) || 0));
        });
    }

    _startWatcher() {
        if (!this._filePath) return;
        if (this._watcher) return;
        try {
            let schedule = null;
            const onFSChange = (eventType, filename) => {
                if (this._suppressWatchEvents) return;
                if (schedule) clearTimeout(schedule);
                schedule = setTimeout(() => {
                    schedule = null;
                    this._handleExternalFileChange().catch(err => {
                        const evt = { type: 'watcher:error', error: err, filename: this._filePath };
                        this._ee.emit('watcher:error', evt);
                    });
                }, Math.max(10, Number(this.opts.watchDebounceMs) || 75));
            };

            // Prefer fs.watch, fallback to fs.watchFile
            try {
                this._watcher = fs.watch(this._filePath, { persistent: true }, onFSChange);
                this._watcher.on('error', (err) => {
                    try { fs.unwatchFile(this._filePath); } catch (e) { /* ignore */ }
                    this._watcher = null;
                    fs.watchFile(this._filePath, { interval: Math.max(50, this.opts.watchDebounceMs || 75) }, (curr, prev) => {
                        if (this._suppressWatchEvents) return;
                        if (curr.mtimeMs !== prev.mtimeMs) onFSChange('change', path.basename(this._filePath));
                    });
                });
            } catch (err) {
                fs.watchFile(this._filePath, { interval: Math.max(50, this.opts.watchDebounceMs || 75) }, (curr, prev) => {
                    if (this._suppressWatchEvents) return;
                    if (curr.mtimeMs !== prev.mtimeMs) onFSChange('change', path.basename(this._filePath));
                });
            }
        } catch (e) {
            this._watcher = null;
        }
    }

    async _handleExternalFileChange() {
        if (this._isWriting || this._suppressWatchEvents) return;

        try {
            // Capture runtime state BEFORE reading from disk (fixes false-negative change detection)
            const oldRuntime = GentleDB._cloneSafe(this._low && this._low.data !== undefined ? this._low.data : {});

            // Read the adapter to get latest disk state
            await this._low.read();
            const diskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);

            // If disk matches last known on-disk snapshot, update snapshot and return
            if (this._jsonEqual(diskSnapshot, this._lastOnDiskSnapshot)) {
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(diskSnapshot);
                return;
            }

            // Apply the disk contents into runtime and update last snapshot
            this._low.data = GentleDB._cloneSafe(diskSnapshot);
            this._lastOnDiskSnapshot = GentleDB._cloneSafe(diskSnapshot);

            const readEvt = this._makeEvent('read', oldRuntime, GentleDB._cloneSafe(diskSnapshot));
            await this._emitSequential('read', readEvt);
            const afterReadEvt = this._makeEvent('afterread', oldRuntime, GentleDB._cloneSafe(diskSnapshot));
            await this._emitSequential('afterread', afterReadEvt);

            const changes = this._computeTopLevelChanges(oldRuntime, diskSnapshot);
            if (Object.keys(changes).length > 0) {
                const changeEvt = this._makeEvent('change', oldRuntime, GentleDB._cloneSafe(diskSnapshot));
                changeEvt.changes = changes;
                await this._emitSequential('change', changeEvt);
            }
        } catch (err) {
            this._ee.emit('watcher:error', { type: 'watcher:read-error', error: err });
        }
    }

    async _acquireLock() {
        if (!this._lockPath) return;
        const start = Date.now();
        const retryDelay = Math.max(10, Number(this.opts.lockRetryDelayMs) || 50);
        const timeout = Math.max(0, Number(this.opts.lockTimeoutMs) || 5000);
        const staleMs = Math.max(1000, Number(this.opts.lockStaleMs) || 10000);

        while (true) {
            try {
                const handle = await fsp.open(this._lockPath, 'wx'); // fails if exists
                const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
                await handle.writeFile(payload, { encoding: 'utf8' });
                this._heldLockHandle = handle;
                return;
            } catch (err) {
                if (err && err.code === 'EEXIST') {
                    // Attempt to detect stale lock more robustly:
                    try {
                        // Try to read and parse the lock file for ts field
                        let content = null;
                        try {
                            content = await fsp.readFile(this._lockPath, 'utf8');
                            const parsed = JSON.parse(content);
                            if (parsed && typeof parsed.ts === 'number') {
                                const now = Date.now();
                                if ((now - parsed.ts) > staleMs) {
                                    try { await fsp.unlink(this._lockPath); } catch (e) { /* ignore */ }
                                    continue;
                                }
                            }
                        } catch (e) {
                            // If read or parse fails, fall back to mtime check below
                        }

                        // Fallback to mtime check
                        try {
                            const stat = await fsp.stat(this._lockPath);
                            const now = Date.now();
                            if ((now - stat.mtimeMs) > staleMs) {
                                try { await fsp.unlink(this._lockPath); } catch (e) { /* ignore */ }
                                continue;
                            }
                        } catch (e) {
                            // If stat fails, try to remove the lock file as a last resort
                            try { await fsp.unlink(this._lockPath); } catch (e2) { /* ignore */ }
                            continue;
                        }
                    } catch (e) {
                        // any unexpected errors — attempt unlink and continue
                        try { await fsp.unlink(this._lockPath); } catch (e2) { /* ignore */ }
                        continue;
                    }

                    if ((Date.now() - start) > timeout) {
                        throw new Error(`Could not acquire DB lock within ${timeout}ms (file: ${this._lockPath})`);
                    }
                    await new Promise(res => setTimeout(res, retryDelay));
                    continue;
                } else {
                    throw err;
                }
            }
        }
    }

    async _releaseLock() {
        if (!this._lockPath) return;
        try {
            if (this._heldLockHandle) {
                try { await this._heldLockHandle.close(); } catch (e) { /* ignore */ }
                this._heldLockHandle = null;
            }
            try { await fsp.unlink(this._lockPath); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }

    _makeEvent(type, oldData, newData) {
        const evt = { type, oldData: GentleDB._cloneSafe(oldData), newData: GentleDB._cloneSafe(newData), _prevented: false, _result: undefined };

        evt.preventDefault = () => { evt._prevented = true; };
        evt.setResult = (v) => { evt._result = v; evt._prevented = true; };

        evt.get = (pth) => this._getAtPath(evt.newData, pth);
        evt.set = (pth, value) => { this._setAtPath(evt.newData, pth, value); return evt; };
        evt.merge = (pth, obj) => { const cur = this._getAtPath(evt.newData, pth) || {}; this._setAtPath(evt.newData, pth, this._deepMerge(GentleDB._cloneSafe(cur), obj)); return evt; };
        evt.delete = (pth) => { this._deleteAtPath(evt.newData, pth); return evt; };
        evt.commit = () => evt;

        return evt;
    }

    _computeTopLevelChanges(oldObj, newObj) {
        const out = {};
        const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
        for (const k of keys) {
            const a = (oldObj || {})[k];
            const b = (newObj || {})[k];
            if (!this._jsonEqual(a, b)) out[k] = { old: GentleDB._cloneSafe(a), new: GentleDB._cloneSafe(b) };
        }
        return out;
    }

    _jsonEqual(a, b) {
        try { return stableStringify(a) === stableStringify(b); } catch (e) { return a === b; }
    }

    static _cloneSafe(x) {
        try { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); } catch (e) { return x; }
    }

    _deepMerge(a, b) {
        if (b === undefined) return a;
        if (a === undefined || a === null) return GentleDB._cloneSafe(b);
        if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(b) || Array.isArray(a)) return GentleDB._cloneSafe(b);
        for (const k of Object.keys(b)) {
            if (b[k] === undefined) continue;
            if (typeof b[k] === 'object' && b[k] !== null && !Array.isArray(b[k])) {
                a[k] = this._deepMerge(a[k] === undefined ? {} : a[k], b[k]);
            } else {
                a[k] = GentleDB._cloneSafe(b[k]);
            }
        }
        return a;
    }

    _getAtPath(root, pathStr) {
        if (!pathStr || pathStr === '') return root;
        const parts = this._splitPath(pathStr);
        let cur = root;
        for (const part of parts) {
            if (cur === undefined || cur === null) return undefined;
            cur = cur[part];
        }
        return cur;
    }

    _setAtPath(root, pathStr, value) {
        if (!pathStr || pathStr === '') {
            if (typeof value === 'object' && value !== null) {
                if (typeof root === 'object' && root !== null) {
                    for (const k of Object.keys(root)) delete root[k];
                    for (const k of Object.keys(value)) root[k] = GentleDB._cloneSafe(value[k]);
                    return;
                }
            }
            throw new Error('Cannot set root path to non-object value in place.');
        }
        const parts = this._splitPath(pathStr);
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            const nextPart = parts[i + 1];
            // create array if next part is numeric index and current missing/ not array
            const nextIsIndex = /^\d+$/.test(String(nextPart));
            if (cur[p] === undefined || cur[p] === null) cur[p] = nextIsIndex ? [] : {};
            cur = cur[p];
            if (typeof cur !== 'object') cur = cur[parts[i]] = {};
        }
        const last = parts[parts.length - 1];
        // clone value when setting
        cur[last] = GentleDB._cloneSafe(value);
    }

    _deleteAtPath(root, pathStr) {
        if (!pathStr || pathStr === '') return;
        const parts = this._splitPath(pathStr);
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (cur[p] === undefined) return;
            cur = cur[p];
            if (cur === undefined || cur === null) return;
        }
        delete cur[parts[parts.length - 1]];
    }

    _splitPath(pathStr) {
        const parts = [];
        const re = /([^[.\]]+)|\[(\d+)\]/g;
        let m;
        while ((m = re.exec(pathStr)) !== null) parts.push(m[1] || m[2]);
        return parts;
    }

    _parseToTokens(query, cfg) {
        if (query == null) return [];
        if (Array.isArray(query) && query.length > 0 && typeof query[0] === 'object' && 'token' in query[0]) {
            return query.map(q => this._normalizeTokenObject(q, cfg)).filter(Boolean);
        }
        if (Array.isArray(query)) return query.map(q => this._normalizeTokenObject({ token: q })).filter(Boolean);
        if (query instanceof RegExp) return [this._normalizeTokenObject({ token: query })];
        if (typeof query === 'string') {
            const out = [];
            const re = /"([^"]+)"|'([^']+)'|\/([^/]+)\/([gimsuy]*)|=([^\s,]+)|([^\s,]+)/g;
            let m;
            while ((m = re.exec(query)) !== null) {
                if (m[1]) out.push({ token: m[1], exactOnly: false });
                else if (m[2]) out.push({ token: m[2], exactOnly: false });
                else if (m[3]) {
                    try { const r = new RegExp(m[3], m[4] || ''); out.push({ token: r, exactOnly: false }); }
                    catch (e) { out.push({ token: `/${m[3]}/`, exactOnly: false }); }
                } else if (m[5]) out.push({ token: m[5], exactOnly: true });
                else if (m[6]) out.push({ token: m[6], exactOnly: false });
            }
            return out.map(o => this._normalizeTokenObject(o, cfg)).filter(Boolean);
        }
        return [this._normalizeTokenObject({ token: String(query), exactOnly: false })];
    }

    _normalizeTokenObject(obj, cfg) {
        if (!obj || typeof obj !== 'object') return null;
        const tok = obj.token;
        if (tok == null) return null;
        if (tok instanceof RegExp) return { token: tok, exactOnly: Boolean(obj.exactOnly), isRegex: true, regex: tok };
        if (typeof tok === 'string') {
            const s = tok.trim();
            const regexLike = s.match(/^\/(.+)\/([gimsuy]*)$/);
            if (regexLike) {
                try {
                    const r = new RegExp(regexLike[1], regexLike[2] || (cfg.caseSensitive ? '' : 'i'));
                    return { token: r, exactOnly: Boolean(obj.exactOnly), isRegex: true, regex: r };
                } catch (e) { }
            }
            const t = cfg.caseSensitive ? s : s.toLowerCase();
            return { token: t, exactOnly: Boolean(obj.exactOnly), isRegex: false };
        }
        const s = String(tok);
        const t = cfg.caseSensitive ? s : s.toLowerCase();
        return { token: t, exactOnly: Boolean(obj.exactOnly), isRegex: false };
    }

    [Symbol.toPrimitive](hint) {
        switch (hint) {
            case 'string': return `[GentleDB@${this._filePath || 'unknown'}]`;
            case 'number': return -1;
            case 'boolean': return Boolean(this._low && this._low.data);
            default: return this._low && this._low.data !== undefined ? this._low.data : undefined;
        }
    }
}

module.exports = GentleDB;
module.exports.default = GentleDB;