// src/examples/basic.cjs.js

// Basic CommonJS usage (path string adapter)

const path = require('path');
const GentleDB = require('../GentleDB');

(async () => {
    const dbFile = path.join(__dirname, 'db', 'examples-data.json');
    const db = new GentleDB(dbFile, { defaultData: { users: [] } });
    await db.read();

    // add a user (merge semantics)
    await db.write({ users: [{ id: 'u1', name: 'Ada' }] });

    // replace entire DB (request a replace op; v1.0.2 does not emit a distinct 'replace' event type,
    // but listeners will see evt.op === 'replace' on the 'write' event)
    // await db.write({ users: [] }, { replace: true });

    const snapshot = await db.getAll();
    console.log('snapshot:', snapshot);

    await db.close();
})();