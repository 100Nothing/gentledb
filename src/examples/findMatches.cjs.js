// src/examples/findMatches.cjs.js

// Demonstrates findMatches usage

const path = require('path');
const GentleDB = require('../GentleDB');

(async () => {
    const dbFile = path.join(__dirname, 'db', 'examples-data.json');
    const db = new GentleDB(dbFile, { defaultData: { items: [{ id: 1, title: 'Hello World' }, { id: 2, title: 'hello again' }] } });
    // Ensure the initial data is persisted
    await db.write({ items: [{ id: 1, title: 'Hello World' }, { id: 2, title: 'hello again' }] }, { replace: true });

    // search (case-insensitive by default)
    const { partial, exact } = await db.findMatches('hello');
    console.log('partial matches:', partial);
    console.log('exact matches:', exact);

    await db.close();
})();