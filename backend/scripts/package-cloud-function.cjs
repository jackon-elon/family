const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'backend', 'dist');
const destination = path.join(root, 'cloudfunctions', 'api', 'lib');
if (!fs.existsSync(path.join(source, 'service.js'))) {
  throw new Error('Compile backend first: npm run build:backend');
}
fs.mkdirSync(destination, {recursive: true});
for (const filename of ['model.js', 'repository.js', 'birthday.js', 'lunar-calendar.js', 'service.js', 'memory-repository.js', 'cloudbase-repository.js']) {
  fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
}
console.log(`Packaged CloudBase function into ${destination}`);
