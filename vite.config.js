const fs = require('fs');

module.exports = {
  server: {
    host: '0.0.0.0',
    port: 3000,
    // HTTPS only for local development
    ...(process.env.NODE_ENV !== 'production' && {
      https: {
        key: fs.readFileSync('./cert.key'),
        cert: fs.readFileSync('./cert.crt'),
      },
    }),
  },
};
