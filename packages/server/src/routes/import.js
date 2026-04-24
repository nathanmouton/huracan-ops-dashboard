const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { importJobs, importInvoices, importReps, importUpsells } = require('../services/csvImport');

const UPLOADS_DIR = path.join(__dirname, '../../data/uploads');

const upload = multer({
  dest: UPLOADS_DIR,
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Only .csv files are accepted'));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const router = Router();

function makeImportHandler(importFn) {
  return async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const locationId = req.body.location_id ? parseInt(req.body.location_id, 10) : null;

    try {
      const summary = await importFn(req.file.path, locationId);
      const hasErrors = summary.errors.length > 0;
      res.status(hasErrors ? 207 : 200).json(summary);
    } finally {
      // Always clean up the temp file
      fs.unlink(req.file.path, () => {});
    }
  };
}

router.post('/jobs',     upload.single('file'), makeImportHandler(importJobs));
router.post('/invoices', upload.single('file'), makeImportHandler(importInvoices));
router.post('/reps',     upload.single('file'), makeImportHandler(importReps));
router.post('/upsells',  upload.single('file'), makeImportHandler(importUpsells));

// Multer error (wrong file type, size limit) reaches Express as a 4xx
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

module.exports = router;
