// src/examples/basic.cjs.js

// Basic CommonJS usage (path string adapter)

const GentleDB = require('../GentleDB');

(async () => {
    const db = new GentleDB('./db/examples-data.json', { defaultData: { users: [] } });
    await db.read();

    // add a user (merge semantics)
    await db.write({ users: [{ id: 'u1', name: 'Ada' }] });

    // replace entire DB
    // await db.write({ users: [] }, { replace: true });

    const snapshot = await db.getAll();
    console.log('snapshot:', snapshot);

    await db.close();
})();