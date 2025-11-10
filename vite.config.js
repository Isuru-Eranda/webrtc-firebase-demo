const fs = require('fs');

module.exports = {
  server: {
    https: {
      key: fs.readFileSync('./cert.key'),
      cert: fs.readFileSync('./cert.crt'),
    },
    host: '0.0.0.0',
    port: 3000,
  },
};
