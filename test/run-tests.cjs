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
        const unsubWrite = db.on('write', (evt) => {
            writeFired = true;
            assert.ok(evt && typeof evt.newData === 'object', 'write event shape wrong');
        });
        const unsubChange = db.on('change', (evt) => {
            changeFired = true;
            assert.ok(evt && typeof evt.changes === 'object', 'change event shape wrong');
        });

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

        // replace semantics
        await db.write({ users: [] }, { replace: true });
        await new Promise((r) => setTimeout(r, 120));
        const data2 = await db.getAll();
        assert.strictEqual(data2.users.length, 0, 'replace did not clear users');

        // findMatches
        await db.write({ items: [{ id: 1, title: 'Hello World' }, { id: 2, title: 'Another' }] });
        await new Promise((r) => setTimeout(r, 120));
        const res = await db.findMatches('hello');
        assert.ok(Array.isArray(res.partial) && (res.partial.length + res.exact.length) >= 1, 'findMatches did not find expected entries');

        // cleanup
        unsubWrite();
        unsubChange();
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