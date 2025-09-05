// src/examples/events.cjs.js

const GentleDB = require('../GentleDB');

(async () => {
    const db = new GentleDB('./db/examples-data.json', { defaultData: { counter: 0 } });

    // listen for writes/changes
    const unsubWrite = db.on('afterwrite', (evt) => {
        console.log('afterwrite fired — newData:', evt.newData);
    });

    const unsubChange = db.on('change', (evt) => {
        console.log('change keys:', Object.keys(evt.changes));
    });

    await db.write({ counter: 1 });
    await db.write({ counter: 2 });

    unsubWrite();
    unsubChange();

    await db.close();
})();