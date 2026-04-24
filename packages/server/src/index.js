require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const express = require('express');
const { getDb, initSchema } = require('../db/schema');
const healthRouter    = require('./routes/health');
const importRouter    = require('./routes/import');
const locationsRouter = require('./routes/locations');
const dashboardRouter = require('./routes/dashboard');
const webhooksRouter  = require('./routes/webhooks');
const syncRouter      = require('./routes/sync');
const salesRouter     = require('./routes/sales');
const { startScheduler } = require('./services/scheduler');

const PORT = process.env.PORT || 3001;

const db = getDb();
initSchema(db);
db.close();

const app = express();
app.use(express.json());

app.use('/api',              healthRouter);
app.use('/api/import',       importRouter);
app.use('/api/locations',    locationsRouter);
app.use('/api/dashboard',    dashboardRouter);
app.use('/api/webhooks',     webhooksRouter);
app.use('/api/sync',         syncRouter);
app.use('/api/sales',        salesRouter);

startScheduler();

if (process.env.NODE_ENV === 'production') {
  const clientBuild = require('path').join(__dirname, '../../client/dist');
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(require('path').join(clientBuild, 'index.html'));
    }
  });
}

app.listen(PORT, () => {
  console.log(`Huracan server running on http://localhost:${PORT}`);
});
