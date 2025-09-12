// src/GentleDB.js

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

class GentleDB {
    // track instances for exit cleanup
    static _instances = new Set();
    static _exitHandlerRegistered = false;

    constructor(adapterOrPath, opts = {}) {
        // Default options
        const defaultOpts = {
            debounceWriteMs: 100,
            debounceReadMs: 50,
            defaultData: {},
            caseSensitive: false,
            maxMatches: 1000,
            lockRetryDelayMs: 50,
            lockTimeoutMs: 5000,
            lockStaleMs: 10000,
            watchDebounceMs: 75,
            registerExitHandlers: true
        };
        this.opts = Object.assign({}, defaultOpts, opts);

        // Normalized numeric options
        this._debounceWriteMs = Math.max(0, Number(this.opts.debounceWriteMs) || 0);
        this._debounceReadMs = Math.max(0, Number(this.opts.debounceReadMs) || 0);
        this._lockRetryDelayMs = Math.max(10, Number(this.opts.lockRetryDelayMs) || 50);
        this._lockTimeoutMs = Math.max(0, Number(this.opts.lockTimeoutMs) || 5000);
        this._lockStaleMs = Math.max(1000, Number(this.opts.lockStaleMs) || 10000);
        this._watchDebounceMs = Math.max(10, Number(this.opts.watchDebounceMs) || 75);
        this._maxMatchesDefault = Math.max(1, Math.floor(this.opts.maxMatches || 1000));
        this.opts.caseSensitive = Boolean(this.opts.caseSensitive);

        // store structuredClone availability once to reduce checks
        this._supportsStructuredClone = (typeof globalThis !== 'undefined' && typeof globalThis.structuredClone === 'function');

        // Event emitter
        this._ee = new EventEmitter();

        // lowdb related (populated in _initPromise)
        this._low = null;
        this._adapter = null;
        this._filePath = null;
        this._lockPath = null;
        this._heldLockHandle = null;

        // Debounce / serialization state
        this._writeTimer = null;
        this._readTimer = null;
        this._pendingWrite = null;
        this._pendingRead = null;
        this._chain = Promise.resolve();

        // Watcher flags
        this._watcher = null;
        this._usingWatchFile = false;
        this._suppressWatchEvents = false;
        this._isWriting = false;
        this._lastOnDiskSnapshot = null;

        // manual lock override flag (used by unlock(permanent=true))
        this._manualUnlocked = false;

        // event chain stack used for preventChain semantics
        // push event contexts here while emitting; listeners can call evt.preventChain()
        this._activeEventStack = [];

        // register instance and exit handler once (optional)
        GentleDB._instances.add(this);
        if (!GentleDB._exitHandlerRegistered && this.opts.registerExitHandlers) {
            GentleDB._exitHandlerRegistered = true;
            const cleanup = () => {
                for (const inst of GentleDB._instances) {
                    try {
                        if (inst && inst._heldLockHandle) {
                            // best-effort synchronous unlink - avoid async work on exit
                            try { fs.unlinkSync(inst._lockPath); } catch (e) { /* ignore */ }
                        }
                    } catch (e) { /* ignore */ }
                }
            };
            process.on('exit', cleanup);
            process.on('SIGINT', () => { cleanup(); process.exit(130); });
            process.on('SIGTERM', () => { cleanup(); process.exit(143); });
        }

        // Expose init promise resolving once lowdb ready
        this._initPromise = (async () => {
            const { Low, JSONFile } = await GentleDB._loadLowdbModule();

            let adapter = adapterOrPath;
            let filePathCandidate = null;

            if (typeof adapterOrPath === 'string') {
                filePathCandidate = path.resolve(String(adapterOrPath));
                // ensure directory exists
                try {
                    await fsp.mkdir(path.dirname(filePathCandidate), { recursive: true });
                } catch (err) {
                    throw new Error(`GentleDB: failed to ensure directory exists from path ${filePathCandidate}: ${err && err.message ? err.message : String(err)}`);
                }
                if (!JSONFile) {
                    throw new Error('GentleDB: lowdb JSONFile adapter not found for string path usage.');
                }
                adapter = new JSONFile(filePathCandidate);
                this._filePath = filePathCandidate;
            } else if (adapterOrPath && typeof adapterOrPath === 'object') {
                // best-effort discover filename
                try {
                    this._filePath = adapterOrPath.filename || adapterOrPath.filePath || adapterOrPath.path || adapterOrPath.file || null;
                } catch (e) {
                    this._filePath = null;
                }
            } else {
                throw new Error('GentleDB: adapterOrPath must be a path string or a lowdb adapter instance.');
            }

            this._filePath ??= filePathCandidate ? filePathCandidate : null;
            this._lockPath = this._filePath ? `${this._filePath}.lock` : null;

            this._adapter = adapter;
            try {
                this._low = new Low(this._adapter, this.opts.defaultData || {});
            } catch (err) {
                throw new Error(`GentleDB: failed to construct Low(adapter). Underlying error: ${err && err.message ? err.message : String(err)}`);
            }

            // initial read + write defaults
            try { await this._low.read(); } catch (e) { /* ignore */ }
            if (this._low.data === undefined || this._low.data === null) {
                this._low.data = GentleDB._cloneSafe(this.opts.defaultData);
                try { await this._low.write(); } catch (e) { /* ignore */ }
            }
            try {
                await this._low.read();
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);
            } catch (e) {
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(this.opts.defaultData);
            }

            if (this._filePath) this._startWatcher();

            return true;
        })();
    }

    on(name, fn) {
        const deprecated = new Set(['beforeread', 'beforewrite', 'afterread', 'afterwrite']);
        if (deprecated.has(String(name))) {
            try {
                const warnKey = `__warned_${name}`;
                if (!this[warnKey]) {
                    console.warn(`GentleDB: event "${name}" is deprecated and will be removed in 1.1.0. Use canonical events (write, read, change, lock, unlock, error).`);
                    this[warnKey] = true;
                }
            } catch (e) { /* ignore */ }
        }
        this._ee.on(name, fn);
        // intentionally do not return an unsubscribe function - rely on off(name, fn)
    }

    off(name, fn) {
        try { this._ee.off(name, fn); return true; } catch (e) { return false; }
    }

    async read() {
        await this._initPromise;
        return this._debouncedRead();
    }

    // write() is now strictly a partial write method and does not accept an options argument.
    async write(partialOrFullData = undefined) {
        await this._initPromise;
        return this._debouncedWrite(partialOrFullData, {});
    }

    // replace: full-replace write (emits 'replace' event; for compatibility also emits 'write' events)
    async replace(fullData) {
        await this._initPromise;
        return this._debouncedWrite(fullData, { replace: true, op: 'replace' });
    }

    // resetDefault: replace DB contents with configured defaultData (op: 'resetDefault')
    async resetDefault() {
        await this._initPromise;
        const def = GentleDB._cloneSafe(this.opts.defaultData === undefined ? {} : this.opts.defaultData);
        return this._debouncedWrite(def, { replace: true, op: 'resetDefault' });
    }

    async getAll() {
        await this._initPromise;
        return this.read();
    }

    // findMatches: streaming, safe for large DBs
    async findMatches(query, opts = {}) {
        await this._initPromise;

        const cfg = {
            caseSensitive: opts.caseSensitive ?? this.opts.caseSensitive,
            searchKeys: Boolean(opts.searchKeys),
            maxMatches: Math.max(1, Math.floor(opts.maxMatches ?? this._maxMatchesDefault))
        };

        const rawTokens = this._parseToTokens(query, cfg);
        if (!rawTokens || rawTokens.length === 0) return { partial: [], exact: [] };

        // precompile normalized tokens
        const tokens = rawTokens.map(t => {
            if (t.isRegex) {
                const re = t.regex instanceof RegExp ? t.regex : new RegExp(String(t.token));
                const anchored = t.exactOnly ? new RegExp(`^(?:${re.source})$`, re.flags) : re;
                return { isRegex: true, regex: re, anchored, exactOnly: Boolean(t.exactOnly) };
            } else {
                const tokenNorm = cfg.caseSensitive ? String(t.token) : String(t.token).toLowerCase();
                return { isRegex: false, tokenNorm, exactOnly: Boolean(t.exactOnly) };
            }
        });

        // Ensure latest on-disk content
        await this._low.read();
        const snapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);

        const partial = [];
        const exact = [];
        const seen = new Set();
        const limit = cfg.maxMatches;

        const tryMatchLeaf = (origin, leafVal) => {
            const leafStr = (leafVal === null || leafVal === undefined) ? String(leafVal) : (typeof leafVal === 'object' ? JSON.stringify(leafVal) : String(leafVal));
            const norm = cfg.caseSensitive ? leafStr : leafStr.toLowerCase();

            for (const tk of tokens) {
                if (partial.length + exact.length >= limit) return true;
                if (tk.isRegex) {
                    const re = tk.exactOnly ? tk.anchored : tk.regex;
                    const key = `r:${origin}:${re.source}:${re.flags}:${tk.exactOnly ? 'e' : 'p'}`;
                    if (re.test(leafStr) && !seen.has(key)) {
                        if (tk.exactOnly) exact.push({ origin, match: leafVal }); else partial.push({ origin, match: leafVal });
                        seen.add(key);
                    }
                } else {
                    const keyExact = `e:${origin}:${tk.tokenNorm}`;
                    const keyPartial = `p:${origin}:${tk.tokenNorm}`;
                    if (norm === tk.tokenNorm) {
                        if (!seen.has(keyExact)) { exact.push({ origin, match: leafVal }); seen.add(keyExact); }
                        continue;
                    }
                    if (tk.exactOnly) continue;
                    if (norm.includes(tk.tokenNorm)) {
                        if (!seen.has(keyPartial)) { partial.push({ origin, match: leafVal }); seen.add(keyPartial); }
                    }
                }
            }
            return partial.length + exact.length >= limit;
        };

        const walk = (node, curPath) => {
            if (partial.length + exact.length >= limit) return true;
            if (node === null || node === undefined) {
                if (tryMatchLeaf(curPath || '(root)', node)) return true;
                return false;
            }
            if (Array.isArray(node)) {
                if (node.length === 0) {
                    if (tryMatchLeaf(curPath || '(root)', node)) return true;
                    return false;
                }
                for (let i = 0; i < node.length; i++) {
                    if (walk(node[i], `${curPath || '(root)'}[${i}]`)) return true;
                }
            } else if (typeof node === 'object') {
                const keys = Object.keys(node);
                if (keys.length === 0) {
                    if (tryMatchLeaf(curPath || '(root)', node)) return true;
                    return false;
                }
                for (const k of keys) {
                    const childPath = curPath ? `${curPath}.${k}` : k;
                    if (cfg.searchKeys) {
                        if (tryMatchLeaf(`${childPath}#key`, k)) return true;
                    }
                    if (walk(node[k], childPath)) return true;
                }
            } else {
                if (tryMatchLeaf(curPath || '(root)', node)) return true;
            }
            return partial.length + exact.length >= limit;
        };

        walk(snapshot, '');

        return { partial, exact };
    }

    async close() {
        try {
            if (this._watcher && typeof this._watcher.close === 'function') {
                try { this._watcher.close(); } catch (e) { /* ignore */ }
                this._watcher = null;
            }
            if (this._usingWatchFile && this._filePath) {
                try { fs.unwatchFile(this._filePath); } catch (e) { /* ignore */ }
                this._usingWatchFile = false;
            }
        } catch (e) { /* ignore */ }

        try { await this._releaseLock(); } catch (e) { /* ignore */ }

        GentleDB._instances.delete(this);
    }

    // lock(permanent: boolean) - public
    async lock(permanent = false) {
        await this._initPromise;
        if (!this._lockPath) return false;
        // If chain suppression active, perform lock without emitting events
        if (!this._canEmit()) {
            await this._acquireLock();
            if (permanent) this._manualUnlocked = false;
            return true;
        }

        const evt = this._makeEvent('lock', 'lock', this._low && this._low.data, this._low && this._low.data);
        await this._emitSequential('lock', evt);
        // legacy compatibility: emit before/after if listeners expect them
        const legacyBefore = this._makeEvent('beforewrite', 'lock', evt.oldData, evt.newData);
        await this._emitSequential('beforewrite', legacyBefore);
        if (evt.defaultPrevented || legacyBefore._prevented) return evt._result ?? legacyBefore._result;

        await this._acquireLock();
        if (permanent) this._manualUnlocked = false;

        const legacyAfter = this._makeEvent('afterwrite', 'lock', evt.oldData, evt.newData);
        await this._emitSequential('afterwrite', legacyAfter);

        return true;
    }

    async unlock(permanent = false) {
        await this._initPromise;
        if (!this._lockPath) return false;
        if (!this._canEmit()) {
            await this._releaseLock();
            if (permanent) this._manualUnlocked = true;
            return true;
        }

        const evt = this._makeEvent('unlock', 'unlock', this._low && this._low.data, this._low && this._low.data);
        await this._emitSequential('unlock', evt);
        const legacyBefore = this._makeEvent('beforewrite', 'unlock', evt.oldData, evt.newData);
        await this._emitSequential('beforewrite', legacyBefore);
        if (evt.defaultPrevented || legacyBefore._prevented) return evt._result ?? legacyBefore._result;

        await this._releaseLock();
        if (permanent) this._manualUnlocked = true;

        const legacyAfter = this._makeEvent('afterwrite', 'unlock', evt.oldData, evt.newData);
        await this._emitSequential('afterwrite', legacyAfter);

        return true;
    }

    restoreLock() {
        this._manualUnlocked = false;
        try { this._ee.emit('restoreLock', { type: 'restoreLock', timestamp: Date.now() }); } catch (e) { /* ignore */ }
        return true;
    }

    // -- internals --

    static async _loadLowdbModule() {
        // try require first
        try {
            const m = require('lowdb');
            if (m && m.Low && m.JSONFile) return { Low: m.Low, JSONFile: m.JSONFile };
            try {
                const nodePart = require('lowdb/node');
                if (nodePart && nodePart.JSONFile) return { Low: m.Low, JSONFile: nodePart.JSONFile };
            } catch (e) { /* ignore */ }
            if (m && m.Low) return { Low: m.Low, JSONFile: m.JSONFile || undefined };
        } catch (err) {
            // ignore, fallback to dynamic import
        }

        // fallback dynamic import
        try {
            const mod = await import('lowdb').then(m => m).catch(() => null);
            const modNode = await import('lowdb/node').then(m => m).catch(() => null);

            const Low = (mod && (mod.Low || mod.default?.Low)) || (modNode && (modNode.Low || modNode.default?.Low)) || null;
            const JSONFile = (mod && (mod.JSONFile || mod.default?.JSONFile)) || (modNode && (modNode.JSONFile || modNode.default?.JSONFile)) || undefined;

            if (Low) return { Low, JSONFile };
            throw new Error('Could not locate lowdb exports (Low/JSONFile).');
        } catch (err) {
            throw new Error(`GentleDB requires lowdb (v3+). Failed to load lowdb: ${err && err.message ? err.message : String(err)}. Install lowdb via: npm i lowdb`);
        }
    }

    // Check whether emitting events is allowed (inspect active event stack for preventChain)
    _canEmit() {
        for (let i = this._activeEventStack.length - 1; i >= 0; i--) {
            const ctx = this._activeEventStack[i];
            if (ctx && ctx.chainPrevented) return false;
        }
        return true;
    }

    // Emit sequentially to each listener. If chain suppressed, skip calling listeners but return the event object.
    async _emitSequential(name, evt) {
        if (!this._canEmit()) return evt;

        const listeners = this._ee.listeners(name).slice();

        // push ctx for preventChain semantics
        this._activeEventStack.push(evt);
        try {
            for (const l of listeners) {
                try {
                    const res = l(evt);
                    if (res && typeof res.then === 'function') await res;
                } catch (err) {
                    console.error(`GentleDB listener error for ${name}:`, err);
                    evt._listenerError = evt._listenerError || [];
                    evt._listenerError.push({ listener: l, error: err });
                }
            }
        } finally {
            this._activeEventStack.pop();
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

                        // Emit canonical pre-read 'read' (cancellable) and legacy 'beforeread'
                        if (this._canEmit()) {
                            const readEvt = this._makeEvent('read', 'read', old, GentleDB._cloneSafe(old));
                            await this._emitSequential('read', readEvt);
                            const legacyBefore = this._makeEvent('beforeread', 'read', old, GentleDB._cloneSafe(old));
                            await this._emitSequential('beforeread', legacyBefore);

                            if (readEvt.defaultPrevented || legacyBefore._prevented) {
                                const result = (typeof readEvt._result !== 'undefined') ? readEvt._result : legacyBefore._result;
                                // emit legacy afterread for compatibility
                                const afterEvt = this._makeEvent('afterread', 'read', old, GentleDB._cloneSafe(result));
                                if (this._canEmit()) await this._emitSequential('afterread', afterEvt);
                                for (const r of pending.resolvers) r(GentleDB._cloneSafe(result));
                                return;
                            }
                        }

                        // perform adapter read
                        await this._low.read();
                        const snapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);
                        try { this._lastOnDiskSnapshot = GentleDB._cloneSafe(snapshot); } catch (e) { /* ignore */ }

                        // emit legacy post-read for compatibility (post-read)
                        const afterEvt = this._makeEvent('afterread', 'read', old, GentleDB._cloneSafe(snapshot));
                        if (this._canEmit()) await this._emitSequential('afterread', afterEvt);

                        for (const r of pending.resolvers) r(GentleDB._cloneSafe(snapshot));
                    } catch (err) {
                        for (const rej of pending.rejecters) rej(err);
                    }
                });
            }, this._debounceReadMs);
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

                        // op name (for evt.op) - can be 'replace', 'resetDefault' or 'write'
                        const opName = (pending.opts && pending.opts.op) ? String(pending.opts.op) : ((pending.opts && pending.opts.replace) ? 'replace' : 'write');
                        // canonical event type: replace vs write
                        const primaryEventType = (pending.opts && pending.opts.replace) ? 'replace' : 'write';

                        // pre-write emission
                        let primaryEvt, legacyBefore, legacyWritePre;
                        if (this._canEmit()) {
                            // canonical primary event ('write' or 'replace')
                            primaryEvt = this._makeEvent(primaryEventType, opName, oldData, GentleDB._cloneSafe(proposed));
                            await this._emitSequential(primaryEventType, primaryEvt);

                            // legacy beforewrite
                            legacyBefore = this._makeEvent('beforewrite', opName, oldData, GentleDB._cloneSafe(proposed));
                            await this._emitSequential('beforewrite', legacyBefore);

                            // For compatibility: if this is a replace operation, also emit a `write` *pre*-event (single emission)
                            if (primaryEventType !== 'write') {
                                legacyWritePre = this._makeEvent('write', opName, oldData, GentleDB._cloneSafe(primaryEvt && primaryEvt.newData !== undefined ? primaryEvt.newData : proposed));
                                await this._emitSequential('write', legacyWritePre);
                            }

                            // If prevented by either canonical or legacy, respect result and skip actual write
                            if (primaryEvt.defaultPrevented || (legacyBefore && legacyBefore._prevented) || (legacyWritePre && legacyWritePre.defaultPrevented)) {
                                const chosen = (typeof primaryEvt._result !== 'undefined') ? primaryEvt._result : (legacyWritePre && typeof legacyWritePre._result !== 'undefined') ? legacyWritePre._result : legacyBefore._result;
                                // emit legacy afterwrite for compatibility
                                const afterCompat = this._makeEvent('afterwrite', opName, oldData, GentleDB._cloneSafe(primaryEvt && primaryEvt.newData !== undefined ? primaryEvt.newData : (legacyWritePre && legacyWritePre.newData !== undefined ? legacyWritePre.newData : legacyBefore.newData)));
                                if (this._canEmit()) await this._emitSequential('afterwrite', afterCompat);
                                for (const r of pending.resolvers) r(chosen);
                                return;
                            }

                            // Prefer primaryEvt.newData if listener mutated it; else fallback to legacyWritePre.newData, else legacyBefore.newData, else proposed
                            if (primaryEvt && typeof primaryEvt.newData !== 'undefined') {
                                proposed = GentleDB._cloneSafe(primaryEvt.newData);
                            } else if (legacyWritePre && typeof legacyWritePre.newData !== 'undefined') {
                                proposed = GentleDB._cloneSafe(legacyWritePre.newData);
                            } else if (legacyBefore && typeof legacyBefore.newData !== 'undefined') {
                                proposed = GentleDB._cloneSafe(legacyBefore.newData);
                            } else {
                                proposed = GentleDB._cloneSafe(proposed);
                            }
                        }

                        // Update runtime using proposed (may have been mutated by listeners)
                        const finalData = GentleDB._cloneSafe(proposed);
                        if (!this._low) throw new Error('GentleDB internal error: lowdb instance not initialized.');
                        this._low.data = finalData;

                        // Acquire lock, persist
                        await this._acquireLock();
                        this._isWriting = true;
                        this._suppressWatchEvents = true;

                        try {
                            await this._low.write();
                            try { this._lastOnDiskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data); } catch (e) { /* ignore */ }
                        } finally {
                            this._suppressWatchEvents = false;
                            this._isWriting = false;
                            try { await this._releaseLock(); } catch (e) { /* ignore */ }
                        }

                        // Post-write emissions
                        if (this._canEmit()) {
                            // emit legacy afterwrite only - canonical events were emitted as pre-events above
                            const legacyAfter = this._makeEvent('afterwrite', opName, oldData, GentleDB._cloneSafe(finalData));
                            await this._emitSequential('afterwrite', legacyAfter);
                        }

                        // compute and emit change (non-cancellable)
                        const changes = this._computeTopLevelChanges(oldData, finalData);
                        if (Object.keys(changes).length > 0) {
                            const changeEvt = this._makeEvent('change', opName, oldData, GentleDB._cloneSafe(finalData));
                            changeEvt.changes = changes;
                            changeEvt.source = 'internal';
                            changeEvt.timestamp = Date.now();
                            if (this._canEmit()) await this._emitSequential('change', changeEvt);
                        }

                        for (const r of pending.resolvers) r();
                    } catch (err) {
                        try { this._suppressWatchEvents = false; this._isWriting = false; await this._releaseLock(); } catch (e) { /* ignore */ }
                        for (const rej of pending.rejecters) rej(err);
                    }
                });
            }, this._debounceWriteMs);
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
                }, this._watchDebounceMs);
            };

            // Prefer fs.watch, fallback to fs.watchFile
            try {
                this._watcher = fs.watch(this._filePath, { persistent: true }, (evt, filename) => {
                    if (evt === 'rename') {
                        fsp.stat(this._filePath).then(() => onFSChange('rename', filename)).catch(() => onFSChange('rename', filename));
                    } else {
                        onFSChange(evt, filename);
                    }
                });
                this._watcher.on('error', (err) => {
                    try { fs.unwatchFile(this._filePath); } catch (e) { /* ignore */ }
                    this._watcher = null;
                    this._usingWatchFile = true;
                    fs.watchFile(this._filePath, { interval: Math.max(50, this._watchDebounceMs) }, (curr, prev) => {
                        if (this._suppressWatchEvents) return;
                        if (curr.mtimeMs !== prev.mtimeMs) onFSChange('change', path.basename(this._filePath));
                    });
                });
            } catch (err) {
                this._usingWatchFile = true;
                fs.watchFile(this._filePath, { interval: Math.max(50, this._watchDebounceMs) }, (curr, prev) => {
                    if (this._suppressWatchEvents) return;
                    if (curr.mtimeMs !== prev.mtimeMs) onFSChange('change', path.basename(this._filePath));
                });
            }
        } catch (e) {
            this._watcher = null;
            this._usingWatchFile = false;
        }
    }

    async _handleExternalFileChange() {
        if (this._isWriting || this._suppressWatchEvents) return;

        try {
            const oldRuntime = GentleDB._cloneSafe(this._low && this._low.data !== undefined ? this._low.data : {});

            // Emit pre-read 'read' event (cancellable)
            if (this._canEmit()) {
                const preRead = this._makeEvent('read', 'read', oldRuntime, GentleDB._cloneSafe(oldRuntime));
                await this._emitSequential('read', preRead);
                const legacyBefore = this._makeEvent('beforeread', 'read', oldRuntime, GentleDB._cloneSafe(oldRuntime));
                await this._emitSequential('beforeread', legacyBefore);
                if (preRead.defaultPrevented || legacyBefore._prevented) {
                    // aborted by listener - do not apply external change
                    return;
                }
            }

            await this._low.read();
            const diskSnapshot = GentleDB._cloneSafe(this._low.data === undefined ? {} : this._low.data);

            if (this._deepEqual(diskSnapshot, this._lastOnDiskSnapshot)) {
                this._lastOnDiskSnapshot = GentleDB._cloneSafe(diskSnapshot);
                return;
            }

            this._low.data = GentleDB._cloneSafe(diskSnapshot);
            this._lastOnDiskSnapshot = GentleDB._cloneSafe(diskSnapshot);

            // legacy afterread
            if (this._canEmit()) {
                const afterReadEvt = this._makeEvent('afterread', 'read', oldRuntime, GentleDB._cloneSafe(diskSnapshot));
                await this._emitSequential('afterread', afterReadEvt);
            }

            // compute and emit unified change
            const changes = this._computeTopLevelChanges(oldRuntime, diskSnapshot);
            if (Object.keys(changes).length > 0) {
                const changeEvt = this._makeEvent('change', 'external', oldRuntime, GentleDB._cloneSafe(diskSnapshot));
                changeEvt.changes = changes;
                changeEvt.source = 'external';
                changeEvt.timestamp = Date.now();
                if (this._canEmit()) await this._emitSequential('change', changeEvt);
            }
        } catch (err) {
            // emit watcher error via legacy channel
            this._ee.emit('watcher:error', { type: 'watcher:read-error', error: err });
        }
    }

    async _acquireLock() {
        if (!this._lockPath) return;
        const start = Date.now();
        const retryDelay = this._lockRetryDelayMs;
        const timeout = this._lockTimeoutMs;
        const staleMs = this._lockStaleMs;

        while (true) {
            try {
                // attempt exclusive create
                const handle = await fsp.open(this._lockPath, 'wx');
                const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
                await handle.writeFile(payload, { encoding: 'utf8' });

                // try to flush to disk if API available (best-effort)
                try {
                    if (typeof handle.datasync === 'function') {
                        await handle.datasync();
                    } else if (typeof handle.fd === 'number') {
                        try { await fsp.fsync(handle.fd); } catch (e) { /* ignore */ }
                    }
                } catch (e) {
                    // ignore - best-effort
                }

                // keep handle to allow us to close/unlink later
                this._heldLockHandle = handle;
                return;
            } catch (err) {
                if (err && err.code === 'EEXIST') {
                    // file exists - check if stale
                    try {
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
                            // parse/read failed - fallback to mtime
                        }

                        try {
                            const stat = await fsp.stat(this._lockPath);
                            const now = Date.now();
                            if ((now - stat.mtimeMs) > staleMs) {
                                try { await fsp.unlink(this._lockPath); } catch (e) { /* ignore */ }
                                continue;
                            }
                        } catch (e) {
                            // stat failed - try unlink as last resort
                            try { await fsp.unlink(this._lockPath); } catch (e2) { /* ignore */ }
                            continue;
                        }
                    } catch (e) {
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

    _makeEvent(type, op = '', oldData = undefined, newData = undefined) {
        const evt = {
            type,
            op: op || '',
            timestamp: Date.now(),
            oldData: GentleDB._cloneSafe(oldData),
            newData: GentleDB._cloneSafe(newData),
            defaultPrevented: false,
            chainPrevented: false,
            _result: undefined
        };

        // preventDefault: only meaningful for cancellable events (all except 'change' and 'error')
        evt.preventDefault = () => {
            if (type === 'change' || type === 'error') return;
            evt.defaultPrevented = true;
        };
        // preventChain: suppress nested emissions from inside listeners
        evt.preventChain = () => { evt.chainPrevented = true; };
        // setResult - set return result and mark defaultPrevented (except for change/error)
        evt.setResult = (v) => { evt._result = v; if (type !== 'change' && type !== 'error') evt.defaultPrevented = true; };

        // convenience helpers for mutating newData
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
            if (!this._deepEqual(a, b)) out[k] = { old: GentleDB._cloneSafe(a), new: GentleDB._cloneSafe(b) };
        }
        return out;
    }

    // Use structuredClone if available; otherwise safe JSON fallback
    static _cloneSafe(x) {
        if (typeof globalThis !== 'undefined' && typeof globalThis.structuredClone === 'function') {
            try { return structuredClone(x); } catch (e) { /* fallback */ }
        }
        try { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); } catch (e) { return x; }
    }

    // Short-circuiting deep equal for common shapes (fast for large objects)
    _deepEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return a === b;
        if (typeof a !== typeof b) return false;
        if (typeof a !== 'object') return a === b;

        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b)) return false;
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!this._deepEqual(a[i], b[i])) return false;
            }
            return true;
        }

        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;

        for (const k of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!this._deepEqual(a[k], b[k])) return false;
        }
        return true;
    }

    _deepMerge(a, b) {
        if (b === undefined) return a;
        if (a === undefined || a === null) return GentleDB._cloneSafe(b);
        if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return GentleDB._cloneSafe(b);

        for (const k of Object.keys(b)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            const bv = b[k];
            if (bv === undefined) continue;
            if (typeof bv === 'object' && bv !== null && !Array.isArray(bv)) {
                a[k] = this._deepMerge(a[k] === undefined ? {} : a[k], bv);
            } else {
                a[k] = GentleDB._cloneSafe(bv);
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
            if (!Object.prototype.hasOwnProperty.call(cur, part) && typeof cur !== 'function') {
                // harmless: will return undefined if doesn't exist
            }
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
            const np = nextPart;
            const nextIsIndex = (typeof np === 'string' && np.length > 0 && /^[0-9]+$/.test(np));

            if (cur[p] === undefined || cur[p] === null) cur[p] = nextIsIndex ? [] : {};
            cur = cur[p];

            if (cur === null || (typeof cur !== 'object' && !Array.isArray(cur))) {
                cur = cur[parts[i]] = {};
            }
        }

        const last = parts[parts.length - 1];
        cur[last] = GentleDB._cloneSafe(value);
    }

    _deleteAtPath(root, pathStr) {
        if (!pathStr) return;
        const parts = this._splitPath(pathStr);
        if (parts.length === 0) return;

        let parent = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (parent == null || parent[key] === undefined) return;
            parent = parent[key];
            if (parent == null || (typeof parent !== 'object' && !Array.isArray(parent))) return;
        }

        const lastKey = parts[parts.length - 1];
        if (parent != null && Object.prototype.hasOwnProperty.call(parent, lastKey)) {
            delete parent[lastKey];
        }
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
            const re = /"([^\"]+)"|'([^']+)'|\/([^/]+)\/([gimsuy]*)|=([^\s,]+)|([^\s,]+)/g;
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
                } catch (e) { /* fall-through */ }
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