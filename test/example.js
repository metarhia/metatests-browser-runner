'use strict';

const metatests = require('metatests');

const f1 = x => x * 2;
const f2 = x => x + 3;

const namespace = { submodule: { f1, f2 } };

metatests.case('Declarative example', namespace, {
  'submodule.f1': [
    [1, 2],
    [2, 4],
    [3, 6],
  ],
  'submodule.f2': [
    [1, 4],
    [2, 5],
    [3, 6],
  ],
});

metatests.test('Check if running in browser environment', test => {
  test.strictSame(process.browser, true);
  test.end();
});
