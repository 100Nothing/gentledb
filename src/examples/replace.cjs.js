// src/examples/replace.cjs.js

// Demomnstrates replace usage

const path = require('path');
const GentleDB = require('../GentleDB');

(async () => {
    const dbFile = path.join(os.tmpdir(), 'gentledb-test-db.json');
    const db = new GentleDB(dbFile, { defaultData: { config: { user: 'John_Doe', password: 'secret', role: 'guest' } } });

    // Set up a replace listener
    db.on('replace', (evt) => {
        if (evt.op === 'replace')
            console.log('Database was replaced, new data:', JSON.stringify(evt.newData, null, 2));
        else if (evt.op === 'resetDefault')
            console.log('Database was reset to default data, new data:', JSON.stringify(evt.newData, null, 2));
    });

    // Set up a write listener
    db.on('write', (evt) => {
        if (evt.op === 'write')
            console.log('Database was written, new data:', JSON.stringify(evt.newData, null, 2));
    });

    // Write new data
    await db.write({ config: { role: 'admin' } });

    // Replace entire DB - no role field for difference
    await db.replace({ config: { user: 'Jane_Doe', password: 'secret' } });

    // Reset to default data
    await db.resetDefault();

    await db.close();
});