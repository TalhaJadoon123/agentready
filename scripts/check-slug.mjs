import { serverSlug, kebabCase } from '../packages/shared/dist/utils.js';

const cases = ['ok-name', 'a; rm -rf /', '$(whoami)', '--flag', 'x`id`b', 'a&y|z', '..', '', 'Ünïcodé', 'a b\tc'];
for (const t of cases) {
  console.log(JSON.stringify(t).padEnd(18), '->', JSON.stringify(serverSlug(t)));
}
console.log('kebabCase:', JSON.stringify(kebabCase('../../etc/passwd')));