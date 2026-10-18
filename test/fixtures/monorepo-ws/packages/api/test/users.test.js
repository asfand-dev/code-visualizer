const { listUsers } = require('../src/users');

test('lists users', () => {
  expect(listUsers()).toHaveLength(1);
});
