// src/examples/findMatches.cjs.js

const GentleDB = require('../GentleDB');

(async () => {
    const db = new GentleDB('./db/examples-data.json', { defaultData: { items: [{ id: 1, title: 'Hello World' }, { id: 2, title: 'hello again' }] } });
    await db.write({ items: db._low?.data?.items || [] }); // ensure persisted

    // search (case-insensitive by default)
    const { partial, exact } = await db.findMatches('hello');
    console.log('partial matches:', partial);
    console.log('exact matches:', exact);

    await db.close();
})();