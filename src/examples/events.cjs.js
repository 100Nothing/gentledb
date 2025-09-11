// src/examples/events.cjs.js

// Demonstrates canonical events and how to cancel/mutate

const path = require('path');
const GentleDB = require('../GentleDB');

(async () => {
    const dbFile = path.join(__dirname, 'db', 'examples-data.json');
    const db = new GentleDB(dbFile, { defaultData: { counter: 0 } });

    // Set up handlers
    function writeHandler(evt) {
        console.log('[write] op:', evt.op, 'proposed newData:', evt.newData);
        // Example: prevent writes that would set counter to 13
        const proposedCounter = evt.get('counter');
        if (proposedCounter === 13) {
            evt.setResult('blocked: unlucky number');
        }
    }

    function changeHandler(evt) {
        console.log('[change] source:', evt.source, 'keys changed:', Object.keys(evt.changes));
    }

    function writeWithPreventChain(evt) {
        // If you need to mutate newData but avoid causing nested events when calling other DB methods,
        // you can call preventChain. The underlying operation will still complete.
        evt.preventChain();
        evt.set('timestamp', Date.now());
        // If the listener later calls db.read() here, that read's events will be suppressed because
        // preventChain was called.
    }

    // Listen to the canonical pre-write event (cancellable)
    db.on('write', writeHandler);

    // Listen to the unified post-change event (not cancellable)
    db.on('change', changeHandler);

    // Example of preventChain usage:
    // preventChain stops nested emissions inside this listener
    db.on('write', writeWithPreventChain);

    // Trigger writes
    console.log('writing counter = 1');
    await db.write({ counter: 1 });

    console.log('writing counter = 2');
    await db.write({ counter: 2 });

    // Example: blocked write
    console.log('attempting to write counter = 13 (should be blocked by listener)');
    const result = await db.write({ counter: 13 });
    console.log('result for blocked write:', result); // 'blocked: unlucky number'

    // cleanup listeners
    db.off('write', writeHandler);
    db.off('change', changeHandler);
    db.off('write', writeWithPreventChain);

    await db.close();
})();