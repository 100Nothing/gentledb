// test/run-tests.cjs

'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

async function run() {
    const dbFile = path.join(os.tmpdir(), 'gentledb-test-db.json');

    // Adjust relative path if your test runner runs from a different cwd
    const GentleDB = require('../src/GentleDB');

    // use short debounces so test runs fast
    const db = new GentleDB(dbFile, {
        defaultData: { users: [], items: [] },
        debounceWriteMs: 20,
        debounceReadMs: 10
    });

    try {
        // initial read / defaultData
        await db.read();
        const data0 = await db.getAll();
        assert.deepStrictEqual(data0, { users: [], items: [] }, 'initial defaultData mismatch');

        // event test: listen for canonical 'write' and 'change'
        let writeFired = false;
        let changeFired = false;

        // store handlers so we can call off(...) later
        const writeHandler = (evt) => {
            writeFired = true;
            assert.ok(evt && typeof evt.newData === 'object', 'write event shape wrong');
        };
        const changeHandler = (evt) => {
            changeFired = true;
            assert.ok(evt && typeof evt.changes === 'object', 'change event shape wrong');
        };

        // on() no longer returns an unsubscribe function in v1.0.3
        db.on('write', writeHandler);
        db.on('change', changeHandler);

        // write (merge semantics)
        await db.write({ users: [{ id: 'u1', name: 'Ada' }] });
        // give debounce time to flush
        await new Promise((r) => setTimeout(r, 120));

        const data1 = await db.getAll();
        assert.strictEqual(Array.isArray(data1.users), true, 'users not an array after write');
        assert.strictEqual(data1.users.length, 1, 'users length after write should be 1');
        assert.strictEqual(data1.users[0].name, 'Ada', 'user name mismatch after write');
        assert.strictEqual(writeFired, true, 'write should have fired');
        assert.strictEqual(changeFired, true, 'change should have fired');

        // replace semantics — use the new replace() API in v1.0.3
        writeFired = false;
        changeFired = false;
        await db.replace({ users: [] });
        await new Promise((r) => setTimeout(r, 120));
        const data2 = await db.getAll();
        assert.strictEqual(data2.users.length, 0, 'replace did not clear users');

        // note: replace() still emits write compatibility events for migration,
        // so the write handler should still observe the operation (legacy compatibility).
        assert.strictEqual(writeFired, true, 'write compatibility event should have fired during replace');
        assert.strictEqual(changeFired, true, 'change should have fired for replace');

        // findMatches
        await db.write({ items: [{ id: 1, title: 'Hello World' }, { id: 2, title: 'Another' }] });
        await new Promise((r) => setTimeout(r, 120));
        const res = await db.findMatches('hello');
        assert.ok(Array.isArray(res.partial) && (res.partial.length + res.exact.length) >= 1, 'findMatches did not find expected entries');

        // cleanup: explicitly remove handlers using off(name, fn)
        db.off('write', writeHandler);
        db.off('change', changeHandler);
        await db.close();

        // remove test DB file
        try { fs.unlinkSync(dbFile); } catch (e) { /* ignore */ }

        console.log('✔ All tests passed');
    } catch (err) {
        try { await db.close(); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(dbFile); } catch (e) { /* ignore */ }
        throw err;
    }
}

run().then(() => process.exit(0)).catch((err) => {
    console.error('✖ Test failure:', err);
    process.exit(1);
});